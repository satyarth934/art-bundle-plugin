"""
Validate robotic liquid-handling instructions before running on the robot.
Reference: liquid-handler-reference.md Phase 7

Checks per well:
  1. Volume balance:            abs(sum(V_i) - V_TOTAL) <= 0.01 uL
  2. Concentration accuracy:    abs(C_calc - C_target) / C_target <= 0.001
  3. Pipetting order:           Water first, Culture last
  4. Source layout uniqueness:  no two stocks share (Plate, Column)
"""
import os
import sys
import pandas as pd
import numpy as np


# ---------------------------------------------------------------------------
# Configuration — edit these paths for each project
# ---------------------------------------------------------------------------

INSTRUCTIONS_FILE = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/lh_outputs/lh_instructions_quarter.csv'
TARGETS_FILE      = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/target_concentrations.csv'
STOCKS_FILE       = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/stock_concentrations.csv'
CONFIG_FILE       = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/experiment_config.csv'
OUTPUT_DIR        = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/lh_outputs/'

VOL_TOL  = 0.01    # uL
CONC_TOL = 0.001   # relative

WATER_LABEL   = 'Water'
CULTURE_LABEL = 'Culture'

# ---------------------------------------------------------------------------
# Load inputs
# ---------------------------------------------------------------------------

df_instr   = pd.read_csv(INSTRUCTIONS_FILE)
df_targets = pd.read_csv(TARGETS_FILE)
df_stocks  = pd.read_csv(STOCKS_FILE, index_col='Component')
df_config  = pd.read_csv(CONFIG_FILE, index_col='Parameter')

v_total        = float(df_config.loc['V_TOTAL', 'Value'])
base_media_vol = float(df_config.loc['BASE_MEDIA_VOL', 'Value']) if 'BASE_MEDIA_VOL' in df_config.index else 0.0

# Component columns: exclude plate/well metadata and the anonymous base media entry
NON_COMPONENT_COLS = {'Plate', 'Well', 'Line_name', 'Sample_name', 'Replicate_ID'}
component_cols  = [c for c in df_targets.columns if c not in NON_COMPONENT_COLS]
df_targets_idx  = df_targets.set_index('Well')

all_passed = True

# ---------------------------------------------------------------------------
# Check 1: Volume balance
# ---------------------------------------------------------------------------

print('[1] Volume balance...')
vol_errors = []
for (dest_plate, dest_well), grp in df_instr.groupby(['Dest_Plate', 'Dest_Well']):
    total = grp['Transfer_volume'].sum()
    if abs(total - v_total) > VOL_TOL:
        vol_errors.append({
            'Plate': dest_plate, 'Well': dest_well,
            'Sum_uL': total, 'V_TOTAL': v_total, 'Delta_uL': total - v_total,
        })

if vol_errors:
    print(f'    FAIL — {len(vol_errors)} wells out of balance')
    print(pd.DataFrame(vol_errors).to_string(index=False))
    all_passed = False
else:
    print('    PASS')

# ---------------------------------------------------------------------------
# Check 2: Concentration back-calculation
# ---------------------------------------------------------------------------

print('[2] Concentration accuracy...')
conc_errors = []
for (dest_plate, dest_well), grp in df_instr.groupby(['Dest_Plate', 'Dest_Well']):
    if dest_well not in df_targets_idx.index:
        continue
    for comp in component_cols:
        if comp not in df_stocks.index:
            continue  # Base_Media and other non-stocked entries have no concentration to validate
        c_target = float(df_targets_idx.loc[dest_well, comp])
        if c_target == 0:
            continue
        comp_rows = grp[grp['Component'] == comp]
        if comp_rows.empty:
            conc_errors.append({'Plate': dest_plate, 'Well': dest_well,
                                 'Component': comp, 'Issue': 'Missing transfer'})
            continue
        c_calc = 0.0
        for _, t in comp_rows.iterrows():
            is_low  = str(t.get('Stock', 'High')).lower() == 'low' or \
                      'low' in str(t.get('Source_Plate', '')).lower()
            c_stock = float(df_stocks.loc[comp, 'Low Concentration' if is_low else 'High Concentration'])
            c_calc += float(t['Transfer_volume']) * c_stock / v_total
        rel_err = abs(c_calc - c_target) / c_target
        if rel_err > CONC_TOL:
            conc_errors.append({
                'Plate': dest_plate, 'Well': dest_well, 'Component': comp,
                'C_target': c_target, 'C_calc': round(c_calc, 6), 'Rel_error': round(rel_err, 6),
            })

if conc_errors:
    print(f'    FAIL — {len(conc_errors)} concentration errors')
    print(pd.DataFrame(conc_errors).to_string(index=False))
    all_passed = False
else:
    print('    PASS')

# ---------------------------------------------------------------------------
# Check 3: Pipetting order
# ---------------------------------------------------------------------------

print('[3] Pipetting order...')
order_errors = []
for (dest_plate, dest_well), grp in df_instr.groupby(['Dest_Plate', 'Dest_Well']):
    components = grp['Component'].tolist()
    if WATER_LABEL in components and components[0] != WATER_LABEL:
        order_errors.append({'Plate': dest_plate, 'Well': dest_well, 'Issue': 'Water is not first'})
    if CULTURE_LABEL in components and components[-1] != CULTURE_LABEL:
        order_errors.append({'Plate': dest_plate, 'Well': dest_well, 'Issue': 'Culture is not last'})

if order_errors:
    print(f'    FAIL — {len(order_errors)} order violations')
    print(pd.DataFrame(order_errors).to_string(index=False))
    all_passed = False
else:
    print('    PASS')

# ---------------------------------------------------------------------------
# Check 4: Source layout uniqueness
# ---------------------------------------------------------------------------

print('[4] Source layout uniqueness...')
map_file = os.path.join(OUTPUT_DIR, 'source_plate_map.csv')
if os.path.exists(map_file):
    df_map = pd.read_csv(map_file)
    key_cols = ['Plate', 'Column'] if 'Column' in df_map.columns else ['Plate', 'Source_Well']
    dupes = df_map[df_map.duplicated(subset=key_cols, keep=False)]
    if not dupes.empty:
        print(f'    FAIL — source plate collisions:')
        print(dupes.to_string(index=False))
        all_passed = False
    else:
        print('    PASS')
else:
    print(f'    SKIP — source_plate_map.csv not found at {map_file}')

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

if all_passed:
    print('\nAll validation checks passed.')
else:
    print('\nValidation FAILED — resolve errors before proceeding to the robot.')
    sys.exit(1)
