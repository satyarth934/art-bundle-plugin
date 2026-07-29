"""
Phase 5 — Generate target concentrations from ART recommendations.
Reference: SKILL.md Phase 5

Reads:
  - recommendations_current_cycle.csv  (ART output — one row per design)
  - standard_recipe.csv                (Component, Concentration, Solubility, Variable)

Writes:
  - target_concentrations.csv          (one row per well-replicate)

Column order: Well | <varied components> | <fixed components> | Plate | Line_name | Sample_name | Replicate_ID
"""
import math
from pathlib import Path

import pandas as pd


# ---------------------------------------------------------------------------
# Configuration — edit these for each project
# ---------------------------------------------------------------------------

PROJECT_DIR           = Path('/app/projects/<PROJECT_SLUG>')
RECOMMENDATIONS_PATH  = PROJECT_DIR / 'recommendations_current_cycle.csv'
STANDARD_RECIPE_PATH  = PROJECT_DIR / 'standard_recipe.csv'
OUTPUT_PATH           = PROJECT_DIR / 'target_concentrations.csv'

CYCLE_NUMBER          = 1   # DBTL cycle number, used in well/sample naming
N_PLATES              = 2   # total number of destination plates
DESIGNS_PER_PLATE     = 7   # experimental designs per plate
N_CONTROLS_PER_PLATE  = 1   # control groups per plate
NUM_REPLICATES        = 3   # replicates per design and per control group


# ---------------------------------------------------------------------------
# Well order: column-major, 4 rows x 6 cols = 24 wells per plate
# ---------------------------------------------------------------------------

def well_order() -> list[str]:
    rows = ['A', 'B', 'C', 'D']
    cols = [1, 2, 3, 4, 5, 6]
    return [f'{r}{c}' for c in cols for r in rows]


def main() -> None:
    recs   = pd.read_csv(RECOMMENDATIONS_PATH)
    recipe = pd.read_csv(STANDARD_RECIPE_PATH)

    # Split components into varied (ART-optimized) and fixed (always at standard conc)
    varied_comps = recipe.loc[recipe['Variable'].str.strip().str.upper() == 'Y', 'Component'].tolist()
    fixed_comps  = recipe.loc[recipe['Variable'].str.strip().str.upper() == 'N', 'Component'].tolist()

    standards = {str(r['Component']): float(r['Concentration']) for _, r in recipe.iterrows()}

    wells = well_order()
    rows: list[dict] = []

    for p in range(1, N_PLATES + 1):
        plate = f'P{p}'
        ptr   = 0

        # Experimental designs
        for d in range(DESIGNS_PER_PLATE):
            design_idx = (p - 1) * DESIGNS_PER_PLATE + d
            design_num = design_idx + 1
            line       = f'C{CYCLE_NUMBER}_{plate}_D{design_num}'
            vals       = recs.iloc[design_idx]

            for rep in range(1, NUM_REPLICATES + 1):
                row = {
                    'Well':         wells[ptr],
                    **{c: float(vals[c]) for c in varied_comps},
                    **{c: float(standards[c]) for c in fixed_comps},
                    'Plate':        plate,
                    'Line_name':    line,
                    'Sample_name':  f'{line}-R{rep}',
                    'Replicate_ID': f'R{rep}',
                }
                rows.append(row)
                ptr += 1

        # Controls — varied components at standard concentration, fixed at standard
        for ctrl_idx in range(1, N_CONTROLS_PER_PLATE + 1):
            ctrl_label = 'Ctrl' if N_CONTROLS_PER_PLATE == 1 else f'Ctrl{ctrl_idx}'
            line       = f'C{CYCLE_NUMBER}_{plate}_{ctrl_label}'

            for rep in range(1, NUM_REPLICATES + 1):
                row = {
                    'Well':         wells[ptr],
                    **{c: float(standards[c]) for c in varied_comps},
                    **{c: float(standards[c]) for c in fixed_comps},
                    'Plate':        plate,
                    'Line_name':    line,
                    'Sample_name':  f'{line}-R{rep}',
                    'Replicate_ID': f'R{rep}',
                }
                rows.append(row)
                ptr += 1

    col_order = ['Well'] + varied_comps + fixed_comps + ['Plate', 'Line_name', 'Sample_name', 'Replicate_ID']
    out = pd.DataFrame(rows)[col_order]
    out.to_csv(OUTPUT_PATH, index=False)

    print(f'Saved: {OUTPUT_PATH}')
    print(f'Rows: {len(out)} | Plates: {N_PLATES} | Varied: {len(varied_comps)} | Fixed: {len(fixed_comps)}')


if __name__ == '__main__':
    main()
