"""
ART optimization — dual-alpha execution strategy.
Reference: media-optimization-reference.md Sections 4.1–4.5
Follows art_code/art_template.py conventions.

Training data CSV must have:
  - 'Line Name' column: sample+replicate id (e.g. "condition1-R1")
  - One column per input variable and one per response variable

Log/linear bounds transformation applied ONLY for initial_cycle=True.
Exploitation (alpha=0.0) runs first, exploration (alpha=1.0) second.
"""
import os
import sys
import numpy as np
import pandas as pd

sys.path.append('/app/art-core/src')
from art.core import RecommendationEngine

sys.path.insert(0, '/app/media_compiler')
from stocks_bounds_lib import transform_bounds_for_art, inverse_transform_recommendations


# ---------------------------------------------------------------------------
# Configuration — edit these paths for each project
# ---------------------------------------------------------------------------

DATA_FILE    = '/app/projects/<PROJECT_SLUG>/data/training_data.csv'  # set to None for initial cycle
ART_CONFIG   = '/app/projects/<PROJECT_SLUG>/art_config.csv'
BOUNDS_FILE  = '/app/projects/<PROJECT_SLUG>/feasible_bounds.csv'
OUTPUT_DIR   = '/app/projects/<PROJECT_SLUG>/art_output/'

# ---------------------------------------------------------------------------
# Load config
# ---------------------------------------------------------------------------

def _bool(v):
    return str(v).strip().lower() in ('true', '1', 'yes')

df_cfg = pd.read_csv(ART_CONFIG, index_col='Parameter')
cfg = df_cfg['Value'].to_dict()

initial_cycle      = _bool(cfg.get('initial_cycle', 'False'))
target_var         = str(cfg.get('target_for_optimization', '')).strip()
strategy           = str(cfg.get('strategy', 'maximize')).strip()
components         = [c.strip() for c in str(cfg.get('components_for_optimization', '')).split(',')]
exploitation_recs  = int(cfg.get('exploitation_recs', 10))
exploration_recs   = int(cfg.get('exploration_recs', 4))
num_recommendations = int(cfg.get('num_recommendations', 14))
niter              = int(cfg.get('niter', 100000))
cross_val_parts    = max(2, int(cfg.get('cross_val_partitions', 5)))  # must be >= 2 (Gotcha #3)
rel_rec_distance   = float(cfg.get('rel_rec_distance', 0.3))
num_tpot_models    = int(cfg.get('num_tpot_models', 0))
result_suffix      = str(cfg.get('result_suffix', '_cycle')).strip()
seed               = int(cfg.get('seed', 42))

# ---------------------------------------------------------------------------
# Load bounds — Variable column must NOT be the index (ART requirement)
# ---------------------------------------------------------------------------

bounds_df_raw = pd.read_csv(BOUNDS_FILE)
if 'Variable' not in bounds_df_raw.columns and bounds_df_raw.index.name == 'Variable':
    bounds_df_raw = bounds_df_raw.reset_index()
bounds_df = bounds_df_raw[['Variable', 'Min', 'Max']]

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Initial cycle: ART uses LHS internally; transform bounds for log-scale components
# ---------------------------------------------------------------------------

if initial_cycle:
    df_bounds_indexed = bounds_df_raw.set_index('Variable')
    if 'Scale' not in df_bounds_indexed.columns:
        df_bounds_indexed['Scale'] = 'linear'

    df_transformed, transform_info = transform_bounds_for_art(df_bounds_indexed, scale_col='Scale')
    bounds_for_art = df_transformed.reset_index()[['Variable', 'Min', 'Max']]

    art_params = {
        'input_vars':          components,
        'num_recommendations': num_recommendations,
        'bounds':              bounds_for_art,
        'seed':                seed,
        'output_dir':          OUTPUT_DIR,
        'recommend':           False,
        'result_suffix':       result_suffix,
    }

    art = RecommendationEngine(df=None, **art_params)
    art.num_recommendations = num_recommendations
    art.recommend()
    print('ART has generated initial LHS recommendations')

    df_recs = inverse_transform_recommendations(art.recommendations.copy(), transform_info)

# ---------------------------------------------------------------------------
# Subsequent cycle: dual-alpha strategy on training data
# ---------------------------------------------------------------------------

else:
    df = pd.read_csv(DATA_FILE)
    # 'Line Name' must contain sample+replicate id (e.g. "condition1-R1")
    df_stacked = df.set_index('Line Name').stack().reset_index()
    df_stacked.columns = ['Line Name', 'Measurement Type', 'Value']

    art_params = {
        'input_vars':           components,
        'response_vars':        [target_var],
        'bounds':               bounds_df,
        'objective':            strategy,
        'num_recommendations':  0,
        'max_mcmc_cores':       4,
        'seed':                 seed,
        'output_dir':           OUTPUT_DIR,
        'recommend':            False,
        'result_suffix':        result_suffix,
        'num_tpot_models':      num_tpot_models,
        'niter':                niter,
        'cross_val_partitions': cross_val_parts,
        'rel_rec_distance':     rel_rec_distance,
    }

    art = RecommendationEngine(df=df_stacked, **art_params)  # Gotcha #1: use df=
    print('ART has been trained')

    # Phase 1: Exploitation (alpha=0.0)
    art.alpha = 0.0
    art.num_recommendations = exploitation_recs
    art.recommend()
    print('ART has generated exploitation recommendations')
    df_exploit = art.recommendations.copy()
    df_exploit['label'] = 'exploitation'

    # Phase 2: Exploration (alpha=1.0)
    art.alpha = 1.0
    art.num_recommendations = exploration_recs
    art.recommend()
    print('ART has generated exploration recommendations')
    df_explore = art.recommendations.copy()
    df_explore['label'] = 'exploration'

    df_recs = pd.concat([df_exploit, df_explore], ignore_index=True)

# ---------------------------------------------------------------------------
# Save
# ---------------------------------------------------------------------------

out_file = os.path.join(OUTPUT_DIR, 'recommendations_current_cycle.csv')
df_recs.to_csv(out_file, index=False)
print(f'Saved {len(df_recs)} recommendations to {out_file}')
