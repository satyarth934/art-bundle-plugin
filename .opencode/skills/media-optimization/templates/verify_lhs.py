"""
LHS feasibility verification using media_compiler.
Reference: liquid-handler-reference.md Phase 3

Generates a large LHS design within feasible bounds and checks every sample
is achievable with the computed stocks. Infeasible wells have Water < 0.
"""
import sys
import numpy as np
import pandas as pd

sys.path.insert(0, '/app/media_compiler')
import core
from doe import lhs_maximin


# ---------------------------------------------------------------------------
# Configuration — edit these paths for each project
# ---------------------------------------------------------------------------

STOCKS_FILE  = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/stock_concentrations.csv'
BOUNDS_FILE  = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/feasible_bounds.csv'
CONFIG_FILE  = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/experiment_config.csv'
N_SAMPLES    = 1000
SEED         = 42

# ---------------------------------------------------------------------------
# Load inputs
# ---------------------------------------------------------------------------

df_stocks = pd.read_csv(STOCKS_FILE, index_col='Component')
df_bounds = pd.read_csv(BOUNDS_FILE, index_col='Variable')
df_config = pd.read_csv(CONFIG_FILE, index_col='Parameter')

v_total        = float(df_config.loc['V_TOTAL', 'Value'])
v_min          = float(df_config.loc['MIN_TRANSFER', 'Value'])
culture_factor = int(float(df_config.loc['CULTURE_FACTOR', 'Value']))
base_media_vol = float(df_config.loc['BASE_MEDIA_VOL', 'Value']) if 'BASE_MEDIA_VOL' in df_config.index else 0.0

# Variable=Y components: bounds-driven LHS sampling
# Variable=N components: always at standard concentration, included so water is computed correctly
varied_components = [c for c in df_stocks.index if c in df_bounds.index]
fixed_components  = [c for c in df_stocks.index if c not in df_bounds.index]

df_stocks_all = df_stocks.loc[varied_components + fixed_components]
df_bounds_var = df_bounds.loc[varied_components]

# ---------------------------------------------------------------------------
# Generate LHS design scaled to [Min, Max] per component
# ---------------------------------------------------------------------------

n_factors = len(varied_components)
lhs_unit  = lhs_maximin(n=n_factors, samples=N_SAMPLES, iterations=10, random_state=SEED)

# LHS covers only Variable=Y components; Variable=N components are fixed at standard concentration
design = pd.DataFrame(index=range(N_SAMPLES), columns=varied_components + fixed_components, dtype=float)
for i, comp in enumerate(varied_components):
    lo = float(df_bounds_var.loc[comp, 'Min'])
    hi = float(df_bounds_var.loc[comp, 'Max'])
    design[comp] = lo + lhs_unit[:, i] * (hi - lo)
for comp in fixed_components:
    design[comp] = float(df_stocks.loc[comp, 'High Concentration'])

# ---------------------------------------------------------------------------
# Check feasibility via find_volumes_bulk
# ---------------------------------------------------------------------------

df_volumes, _ = core.find_volumes_bulk(
    df_stock=df_stocks_all,
    df_target_conc=design,
    well_volume=v_total,
    min_tip_volume=v_min,
    culture_ratio=culture_factor,
    verbose=0,
)

# Water feasibility accounts for BASE_MEDIA_VOL consuming part of the well.
# When BASE_MEDIA_VOL=0 this is equivalent to the standard Water < 0 check.
infeasible_mask = df_volumes['Water'] < base_media_vol
n_feasible   = int((~infeasible_mask).sum())
n_infeasible = N_SAMPLES - n_feasible

print(f'Feasible: {n_feasible}/{N_SAMPLES} ({n_feasible / N_SAMPLES:.1%})')

if n_infeasible > 0:
    print(f'WARNING: {n_infeasible} infeasible samples — tighten bounds or increase stock concentrations')
    print(design[infeasible_mask].to_string())
    sys.exit(1)
else:
    print('All LHS samples are feasible.')
