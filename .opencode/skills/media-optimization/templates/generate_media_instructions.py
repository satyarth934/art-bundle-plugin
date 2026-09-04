"""
Generate robotic liquid-handling instructions from target concentrations.
Reference: liquid-handler-reference.md Phases 5–6

Outputs:
  - lh_instructions_quarter.csv  OR  lh_instructions_traditional.csv
  - source_plate_map.csv
  - plate_labware_mapping.csv  (skeleton — fill in Labware column)
"""
import os
import sys
import math
import numpy as np
import pandas as pd

sys.path.insert(0, '/app/media_compiler')
import core


# ---------------------------------------------------------------------------
# Configuration — edit these paths for each project
# ---------------------------------------------------------------------------

TARGETS_FILE = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/target_concentrations.csv'
STOCKS_FILE  = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/stock_concentrations.csv'
CONFIG_FILE  = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/experiment_config.csv'
OUTPUT_DIR   = '/shared/user_impl_alpha/<USER_EMAIL>/<PROJECT_SLUG>/lh_outputs/'
FORMAT       = 'quarter'   # 'quarter' (8-to-4 multichannel) or 'traditional' (1 well per stock)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SOURCE_COLUMNS_QUARTER = [2, 5, 8, 11]
ROWS_24WELL  = ['A', 'B', 'C', 'D']
WATER_LABEL   = 'Water'
CULTURE_LABEL = 'Culture'

# ---------------------------------------------------------------------------
# Load inputs
# ---------------------------------------------------------------------------

df_targets = pd.read_csv(TARGETS_FILE)
df_stocks  = pd.read_csv(STOCKS_FILE, index_col='Component')
df_config  = pd.read_csv(CONFIG_FILE, index_col='Parameter')

v_total        = float(df_config.loc['V_TOTAL', 'Value'])
v_min          = float(df_config.loc['MIN_TRANSFER', 'Value'])
culture_factor = int(float(df_config.loc['CULTURE_FACTOR', 'Value']))
base_media_vol = float(df_config.loc['BASE_MEDIA_VOL', 'Value']) if 'BASE_MEDIA_VOL' in df_config.index else 0.0
v_culture      = v_total / culture_factor

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Compute transfer volumes via find_volumes_bulk
# ---------------------------------------------------------------------------

component_cols    = [c for c in df_targets.columns if c not in ('Plate', 'Well')]
pipetted_comps    = [c for c in component_cols if c in df_stocks.index]
df_target_conc    = df_targets.set_index('Well')[pipetted_comps]

try:
    df_volumes, df_conc_level = core.find_volumes_bulk(
        df_stock=df_stocks.loc[pipetted_comps],
        df_target_conc=df_target_conc,
        well_volume=v_total,
        min_tip_volume=v_min,
        culture_ratio=culture_factor,
        verbose=0,
    )
except Exception as e:
    # Inline fallback: direct dilution with high/low switch (last resort — logged)
    print(f'WARNING: find_volumes_bulk failed ({e}), using inline fallback')
    rows = {}
    for well in df_target_conc.index:
        vols = {}
        for comp in pipetted_comps:
            c_target = float(df_target_conc.loc[well, comp])
            c_high   = float(df_stocks.loc[comp, 'High Concentration'])
            c_low    = float(df_stocks.loc[comp, 'Low Concentration'])
            v_high   = (c_target * v_total) / c_high if c_high > 0 else 0.0
            vols[comp] = (c_target * v_total) / c_low if 0 < v_high < v_min and c_low > 0 else v_high
        vols[WATER_LABEL] = v_total - v_culture - base_media_vol - sum(vols.values())
        rows[well] = vols
    df_volumes = pd.DataFrame(rows).T
    df_conc_level = pd.DataFrame('high', index=df_target_conc.index, columns=pipetted_comps)

# Round volumes
for col in df_volumes.columns:
    df_volumes[col] = core.round_volume(df_volumes[col].values, int(v_total))

# ---------------------------------------------------------------------------
# Source plate allocation
# ---------------------------------------------------------------------------

if FORMAT == 'quarter':
    # Sequential i//4 -> plate, i%4 -> quarter slot; guaranteed collision-free
    stocks_list = []
    for comp in pipetted_comps:
        stocks_list.append((comp, 'High'))
        if float(df_stocks.loc[comp, 'Dilution Factor']) > 1.0:
            stocks_list.append((comp, 'Low'))

    source_map_rows = []
    for i, (comp, stock_type) in enumerate(stocks_list):
        plate_num   = i // len(SOURCE_COLUMNS_QUARTER) + 1
        col         = SOURCE_COLUMNS_QUARTER[i % len(SOURCE_COLUMNS_QUARTER)]
        plate       = f'Source_{plate_num}'
        source_well = f'A{col}'
        source_map_rows.append({
            'Component': comp, 'Stock': stock_type,
            'Plate': plate, 'Column': col,
            'Source_Well': source_well, 'Section': (i % len(SOURCE_COLUMNS_QUARTER)) + 1,
        })

    df_source_map = pd.DataFrame(source_map_rows)
    assert not df_source_map.duplicated(subset=['Plate', 'Column']).any(), \
        'Source plate collision detected'

else:
    # Traditional: columns-first A1, B1, C1, D1, A2, ...
    all_slots = [f'{r}{c}' for c in range(1, 7) for r in ROWS_24WELL]
    source_map_rows = []
    slot_idx  = {'High': 0, 'Low': 0}
    plate_idx = {'High': 1, 'Low': 1}
    for comp in pipetted_comps:
        for stock_type, prefix in [('High', 'High_Plate'), ('Low', 'Low_Plate')]:
            if stock_type == 'Low' and float(df_stocks.loc[comp, 'Dilution Factor']) == 1.0:
                continue
            if slot_idx[stock_type] > 0 and slot_idx[stock_type] % len(all_slots) == 0:
                plate_idx[stock_type] += 1
            plate = f"{prefix}_{plate_idx[stock_type]}" if plate_idx[stock_type] > 1 else prefix
            source_map_rows.append({
                'Component': comp, 'Stock': stock_type,
                'Plate': plate, 'Source_Well': all_slots[slot_idx[stock_type] % len(all_slots)],
            })
            slot_idx[stock_type] += 1

    df_source_map = pd.DataFrame(source_map_rows)

df_source_map.to_csv(os.path.join(OUTPUT_DIR, 'source_plate_map.csv'), index=False)
print(f'Wrote source_plate_map.csv ({len(df_source_map)} rows)')

# ---------------------------------------------------------------------------
# Generate instruction rows (Water first, components, Culture last)
# ---------------------------------------------------------------------------

records = []
dest_plates = df_targets['Plate'].unique().tolist()

for _, target_row in df_targets.iterrows():
    plate = target_row['Plate']
    well  = target_row['Well']

    # Water first — find_volumes_bulk includes BASE_MEDIA_VOL in its water; subtract it here
    v_water = float(df_volumes.loc[well, WATER_LABEL]) - base_media_vol
    if v_water > 0:
        records.append({
            'Source_Plate': 'Water_Plate', 'Source_Well': 'A1',
            'Dest_Plate': plate, 'Dest_Well': well,
            'Component': WATER_LABEL, 'Aspiration_Group': 0, 'Transfer_volume': v_water,
        })

    # Base media immediately after water (fixed volume, every well)
    if base_media_vol > 0:
        records.append({
            'Source_Plate': 'Base_Plate', 'Source_Well': 'A1',
            'Dest_Plate': plate, 'Dest_Well': well,
            'Component': 'Base_Media', 'Aspiration_Group': 0, 'Transfer_volume': base_media_vol,
        })

if FORMAT == 'quarter':
    for _, src_row in df_source_map.iterrows():
        comp       = src_row['Component']
        stock_type = src_row['Stock']
        src_col    = src_row['Column']
        src_plate  = src_row['Plate']
        for dest_plate in dest_plates:
            plate_targets = df_targets[df_targets['Plate'] == dest_plate]
            for asp_idx, (dc1, dc2) in enumerate([(1, 2), (3, 4), (5, 6)]):
                for row in ROWS_24WELL:
                    for dc in [dc1, dc2]:
                        dest_well = f'{row}{dc}'
                        if dest_well not in plate_targets['Well'].values:
                            continue
                        v = float(df_volumes.loc[dest_well, comp])
                        if v == 0:
                            continue  # skip tip; mapping stays fixed for others
                        records.append({
                            'Source_Plate': src_plate, 'Source_Well': f'{row}{src_col}',
                            'Dest_Plate': dest_plate, 'Dest_Well': dest_well,
                            'Component': comp, 'Stock': stock_type,
                            'Aspiration_Group': asp_idx + 1, 'Transfer_volume': v,
                        })
else:
    for _, src_row in df_source_map.iterrows():
        comp = src_row['Component']
        for _, target_row in df_targets.iterrows():
            v = float(df_volumes.loc[target_row['Well'], comp])
            if v == 0:
                continue
            records.append({
                'Source_Plate': src_row['Plate'], 'Source_Well': src_row['Source_Well'],
                'Dest_Plate': target_row['Plate'], 'Dest_Well': target_row['Well'],
                'Component': comp, 'Stock': src_row['Stock'], 'Transfer_volume': v,
            })

# Culture last
for _, target_row in df_targets.iterrows():
    records.append({
        'Source_Plate': 'Fresh_Plate', 'Source_Well': 'A1',
        'Dest_Plate': target_row['Plate'], 'Dest_Well': target_row['Well'],
        'Component': CULTURE_LABEL, 'Aspiration_Group': 99, 'Transfer_volume': v_culture,
    })

df_instructions = pd.DataFrame(records)
fname = f'lh_instructions_{FORMAT}.csv'
df_instructions.to_csv(os.path.join(OUTPUT_DIR, fname), index=False)
print(f'Wrote {fname} ({len(df_instructions)} rows)')

# ---------------------------------------------------------------------------
# Labware mapping skeleton
# ---------------------------------------------------------------------------

all_plates = pd.unique(
    pd.concat([df_instructions['Source_Plate'], df_instructions['Dest_Plate']]))
df_labware = pd.DataFrame({'Plate_name': sorted(all_plates), 'Labware': ''})
df_labware.to_csv(os.path.join(OUTPUT_DIR, 'plate_labware_mapping.csv'), index=False)
print('Wrote plate_labware_mapping.csv — fill in the Labware column before finalizing')
