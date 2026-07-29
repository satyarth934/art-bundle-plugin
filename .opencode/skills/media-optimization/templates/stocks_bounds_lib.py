"""
Dual-stock strategy calculations and ART bounds transformation utilities.
Reference: media-optimization-reference.md Sections 3, 4.2.1
"""
import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Section 3: Dual-Stock Strategy Formulas
# ---------------------------------------------------------------------------

def compute_low_stock(c_min: float, v_well: float, v_min: float, c_high: float) -> float:
    """
    C_LOW = (C_MIN * V_WELL) / V_MIN, capped at C_HIGH.
    Goal: reach C_MIN using exactly V_MIN transfer volume.
    """
    c_low = (c_min * v_well) / v_min
    return min(c_low, c_high)


def compute_switch_point(v_min: float, c_high: float, v_total: float) -> float:
    """
    C_SWITCH = (V_MIN * C_HIGH) / V_TOTAL
    Target concentration where High stock volume drops below V_MIN.
    Below this, the system switches to Low stock.
    """
    return (v_min * c_high) / v_total


def compute_peak_volume(v_min: float, c_high: float, c_low: float) -> float:
    """
    V_PEAK = (V_MIN * C_HIGH) / C_LOW
    Maximum transfer volume, occurring just below the High/Low switch point.
    """
    return (v_min * c_high) / c_low


def compute_volume_at_max(c_max: float, v_total: float, c_high: float) -> float:
    """
    V_at_max = (C_MAX * V_TOTAL) / C_HIGH
    Volume required to reach the maximum bound using High stock.
    """
    return (c_max * v_total) / c_high


def compute_required_volume(c_max: float, v_total: float, c_high: float,
                             v_min: float, c_low: float) -> float:
    """
    V_REQUIRED = max(V_at_max, V_PEAK)
    Worst-case transfer volume for budget feasibility checking.
    """
    v_at_max = compute_volume_at_max(c_max, v_total, c_high)
    v_peak = compute_peak_volume(v_min, c_high, c_low)
    return max(v_at_max, v_peak)


def compute_dilution_factor(c_high: float, c_low: float) -> float:
    """
    Dilution_Factor = C_HIGH / C_LOW
    If == 1: stocks are identical; no separate Low stock needed.
    If > 1: a separate Low stock is required for this component.
    """
    return c_high / c_low


def apply_min_volume_correction(c_high: float, v_i: float, v_min: float) -> float:
    """
    If any component yields V_i < V_MIN at C_MAX, correct the High stock:
        C_HIGH_new = C_HIGH_old / (5 * V_MIN / V_i)
    This forces the required volume up to 5 * V_MIN as a safety buffer.
    """
    return c_high / (5 * v_min / v_i)


# ---------------------------------------------------------------------------
# Section 4.2.1: Linear vs Log Bounds Scaling for ART
# ---------------------------------------------------------------------------

def transform_bounds_for_art(df_bounds: pd.DataFrame,
                              scale_col: str = 'Scale') -> tuple[pd.DataFrame, dict]:
    """
    Pre-ART bounds transformation.

    For log-scale components: passes [log10(Min), log10(Max)] to ART so that
    LHS samples evenly in log space. Linear-scale components are unchanged.

    Args:
        df_bounds: DataFrame indexed by component name, with columns Min, Max, Scale.
        scale_col:  Name of the column containing 'linear' or 'log'.

    Returns:
        df_transformed: Bounds with Min/Max transformed for ART input.
        transform_info: dict mapping component name -> 'linear' or 'log'.
    """
    df_transformed = df_bounds.copy()
    transform_info: dict[str, str] = {}

    for idx, row in df_bounds.iterrows():
        scale = str(row.get(scale_col, 'linear')).strip().lower()
        transform_info[str(idx)] = scale
        if scale == 'log':
            df_transformed.at[idx, 'Min'] = np.log10(float(row['Min']))
            df_transformed.at[idx, 'Max'] = np.log10(float(row['Max']))

    return df_transformed, transform_info


def inverse_transform_recommendations(df_recs: pd.DataFrame,
                                       transform_info: dict) -> pd.DataFrame:
    """
    Post-ART inverse transformation back to concentration space.

    For log-scale components: concentration = 10^(recommended_value).
    For linear-scale components: value is already in concentration space; unchanged.

    Args:
        df_recs:        ART recommendation DataFrame (columns = component names).
        transform_info: dict returned by transform_bounds_for_art.

    Returns:
        df_out: Recommendations in original concentration units.
    """
    df_out = df_recs.copy()
    for col in df_out.columns:
        if transform_info.get(str(col)) == 'log':
            df_out[col] = 10.0 ** df_out[col].astype(float)
    return df_out


# ---------------------------------------------------------------------------
# Utility: resolve bounds from bounds.csv (user-input format -> absolute conc.)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Fixed component stock calculation (Variable=N, individual pipetting mode)
# ---------------------------------------------------------------------------

def compute_fixed_component_stocks(df_recipe: pd.DataFrame,
                                    v_total: float,
                                    v_min: float,
                                    safety_factor: float = 2.0) -> pd.DataFrame:
    """
    Compute a single stock concentration for each Variable=N component.

    Fixed components are always dispensed at their standard concentration, so
    no High/Low split is needed. The stock must be concentrated enough that
    the required transfer volume >= V_MIN at standard concentration.

    Formula:
        C_stock = (C_standard * V_TOTAL) / V_MIN * safety_factor
        capped at Solubility (if provided).

    Dilution Factor is always 1 (High == Low, no separate low stock).

    Args:
        df_recipe:     standard_recipe.csv loaded as DataFrame with columns
                       Component, Concentration, Solubility, Variable.
        v_total:       Total well volume (uL).
        v_min:         Minimum pipette transfer volume (uL).
        safety_factor: Multiplier on the minimum required stock concentration.
                       Default 2.0 gives a 2x headroom above V_MIN.

    Returns:
        DataFrame with columns: Component, Low Concentration,
        High Concentration, Dilution Factor.
    """
    fixed = df_recipe[df_recipe['Variable'].str.strip().str.upper() == 'N'].copy()
    rows = []
    for _, r in fixed.iterrows():
        c_std = float(r['Concentration'])
        sol   = float(r['Solubility']) if pd.notna(r.get('Solubility')) else np.inf
        c_stock = min((c_std * v_total) / v_min * safety_factor, sol)
        rows.append({
            'Component':          r['Component'],
            'Low Concentration':  c_stock,
            'High Concentration': c_stock,
            'Dilution Factor':    1.0,
        })
    return pd.DataFrame(rows)


def resolve_bounds(df_bounds: pd.DataFrame,
                   df_recipe: pd.DataFrame,
                   default_min_mult: float = 0.1,
                   default_max_mult: float = 10.0) -> pd.DataFrame:
    """
    Convert user-input bounds.csv to absolute Min/Max concentrations.

    Resolution priority (per component, per bound):
      1. Absolute concentration (Min_Concentration / Max_Concentration) if set.
      2. Multiplier * standard concentration (Min_Multiplier / Max_Multiplier) if set.
      3. Default multiplier from experiment_config * standard concentration.

    Args:
        df_bounds:        bounds.csv loaded as DataFrame (index = Component).
        df_recipe:        standard_recipe.csv loaded (index = Component).
        default_min_mult: DEFAULT_MIN_MULTIPLIER from experiment_config.csv.
        default_max_mult: DEFAULT_MAX_MULTIPLIER from experiment_config.csv.

    Returns:
        DataFrame with columns: Variable, Min, Max, Scale  (feasible_bounds format).
    """
    rows = []
    for comp in df_bounds.index:
        row = df_bounds.loc[comp]
        std_conc = float(df_recipe.loc[comp, 'Concentration']) if comp in df_recipe.index else 1.0

        min_abs = row.get('Min_Concentration')
        max_abs = row.get('Max_Concentration')
        min_mult = row.get('Min_Multiplier')
        max_mult = row.get('Max_Multiplier')
        scale = str(row.get('Scale', 'linear')).strip().lower()

        if pd.notna(min_abs) and min_abs != '':
            c_min = float(min_abs)
        elif pd.notna(min_mult) and min_mult != '':
            c_min = float(min_mult) * std_conc
        else:
            c_min = default_min_mult * std_conc

        if pd.notna(max_abs) and max_abs != '':
            c_max = float(max_abs)
        elif pd.notna(max_mult) and max_mult != '':
            c_max = float(max_mult) * std_conc
        else:
            c_max = default_max_mult * std_conc

        rows.append({'Variable': comp, 'Min': c_min, 'Max': c_max, 'Scale': scale})

    return pd.DataFrame(rows).set_index('Variable')
