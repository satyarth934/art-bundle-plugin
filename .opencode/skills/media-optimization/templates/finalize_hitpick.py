"""
Produce the master hitpick_final.xlsx for robotic control software.
Reference: liquid-handler-reference.md Phase 8

XLSX sheets:
  1. Transfers        — all liquid transfers
  2. Plate Mapping    — plate name -> labware type
  3. Compatible Labware — reference list of supported labware
"""
import os
import pandas as pd


# ---------------------------------------------------------------------------
# Configuration — edit these paths for each project
# ---------------------------------------------------------------------------

INSTRUCTIONS_FILE = '/app/projects/<PROJECT_SLUG>/lh_outputs/lh_instructions_quarter.csv'
LABWARE_MAP_FILE  = '/app/projects/<PROJECT_SLUG>/lh_outputs/plate_labware_mapping.csv'
OUTPUT_FILE       = '/app/projects/<PROJECT_SLUG>/lh_outputs/hitpick_final.xlsx'
LABWARE_REF_FILE  = None   # optional: '/app/projects/<PROJECT_SLUG>/compatible_labware.csv'

# Default labware list — extend for your robot deck
DEFAULT_LABWARE = [
    '24 Well Plate 3.4 mL',
    '96 Well Plate 200 uL',
    '96 Well Plate 2 mL',
    'Reservoir 25 mL',
    'Tube Rack 1.5 mL',
    'Tube Rack 50 mL',
    'Trough 195 mL',
    'Quarter Reservoir 60 mL',
]

# ---------------------------------------------------------------------------
# Load instructions
# ---------------------------------------------------------------------------

df_instr = pd.read_csv(INSTRUCTIONS_FILE)

TRANSFER_COLS = ['Source_Plate', 'Source_Well', 'Dest_Plate', 'Dest_Well', 'Transfer_volume']

# Sheet 1: Transfers — sorted component-first, then aspiration group
sort_cols = ['Component', 'Aspiration_Group'] if 'Aspiration_Group' in df_instr.columns else ['Component']
sort_cols = [c for c in sort_cols if c in df_instr.columns]
df_transfers = df_instr[TRANSFER_COLS].sort_values(by=sort_cols if sort_cols else TRANSFER_COLS,
                                                     ignore_index=True)

# Sheet 2: Plate Mapping
all_plates = sorted(pd.unique(
    pd.concat([df_transfers['Source_Plate'], df_transfers['Dest_Plate']])))
df_plate_map = pd.DataFrame({'Plate_name': all_plates, 'Labware': ''})

if LABWARE_MAP_FILE and os.path.exists(LABWARE_MAP_FILE):
    df_existing = pd.read_csv(LABWARE_MAP_FILE)
    if {'Plate_name', 'Labware'}.issubset(df_existing.columns):
        lookup = df_existing.set_index('Plate_name')['Labware'].to_dict()
        df_plate_map['Labware'] = df_plate_map['Plate_name'].map(lookup).fillna('')

unmapped = df_plate_map[df_plate_map['Labware'] == '']['Plate_name'].tolist()
if unmapped:
    print(f'WARNING: {len(unmapped)} plates have no labware assigned: {unmapped}')

# Sheet 3: Compatible Labware
if LABWARE_REF_FILE and os.path.exists(LABWARE_REF_FILE):
    df_labware_ref = pd.read_csv(LABWARE_REF_FILE)
else:
    df_labware_ref = pd.DataFrame({'Labware': DEFAULT_LABWARE})

# ---------------------------------------------------------------------------
# Write XLSX
# ---------------------------------------------------------------------------

with pd.ExcelWriter(OUTPUT_FILE, engine='openpyxl') as writer:
    df_transfers.to_excel(writer,    sheet_name='Transfers',          index=False)
    df_plate_map.to_excel(writer,    sheet_name='Plate Mapping',      index=False)
    df_labware_ref.to_excel(writer,  sheet_name='Compatible Labware', index=False)

print(f'Wrote {OUTPUT_FILE}')
print(f'  Transfers:          {len(df_transfers)} rows')
print(f'  Plate Mapping:      {len(df_plate_map)} plates')
print(f'  Compatible Labware: {len(df_labware_ref)} types')
