# Media Optimization -- Technical Reference

This document is the authoritative reference for the media-optimization skill. It contains exact formulas, API signatures, algorithmic details, and known pitfalls. Specialist subagents (`liquid-handler-specialist` and `art-specialist`) should consult this document whenever they need precise calculation logic, edge-case handling, or API details.

---

## 1. Volume Formulas

All volume calculations are grounded in the dilution equation. Given a total well volume, a set of stock solutions, and a set of target concentrations, the transfer volumes are determined as follows.

### 1.1 Volume Budget

Every well receives the following liquid additions:

| Term | Symbol | Description |
|---|---|---|
| Total well volume | `V_TOTAL` | Physical capacity of the destination well (uL) |
| Inoculum | `V_INOCULUM` | Cell culture volume. Typically `V_TOTAL / CULTURE_FACTOR` |
| Base media | `V_BASE_MEDIA` | Fixed volume of a pre-made master mix (e.g., 10x salt solution). **0 if not used.** |
| Individually-pipetted stocks | `sum(V_i)` | All components listed in `standard_recipe.csv` (both Variable=Y and Variable=N) |
| Water | `V_water` | Balance volume, always dispensed first |

**Convention**: Components listed in `standard_recipe.csv` are always pipetted individually by the robot regardless of whether `BASE_MEDIA_VOL` is set. Components inside the master mix are **not listed** in `standard_recipe.csv` — their volume is accounted for solely by `BASE_MEDIA_VOL`. Both can coexist (e.g., 200 uL of 10x salts as base media plus Kanamycin pipetted individually as Variable=N).

### 1.2 Individual Component Volume

Transfer volumes are always calculated relative to `V_TOTAL` (the full well volume), not a reduced budget:

```
V_i = (C_target_i * V_TOTAL) / C_stock_i
```

| Symbol | Description |
|---|---|
| `V_i` | Transfer volume of stock `i` (uL) |
| `C_target_i` | Desired concentration of component `i` in the final well |
| `C_stock_i` | Concentration of the stock solution for component `i` |

### 1.3 Water (Balance) Volume

Water fills all remaining space after inoculum, base media, and all individually-pipetted stocks:

```
V_water = V_TOTAL - V_INOCULUM - V_BASE_MEDIA - sum(V_i for all listed components)
```

Water is always dispensed FIRST (before any media components) to prevent osmotic shock.

### 1.4 Feasibility Constraints

A set of target concentrations is physically feasible if and only if ALL of the following hold:

| Constraint | Formula | Meaning |
|---|---|---|
| Minimum transfer | `V_i >= V_MIN` (for all `V_i > 0`) | Robot can accurately dispense the volume |
| Non-negative water | `V_water >= 0` | All volumes fit within the well |
| Solubility | `C_stock_i <= Solubility_i` | Stock can actually be prepared at that concentration |

**Implementation note**: `find_volumes_bulk` computes `V_water` as `V_TOTAL - V_INOCULUM - sum(V_i)`. When `BASE_MEDIA_VOL > 0`, the feasibility check must therefore use `df_volumes['Water'] < BASE_MEDIA_VOL` (not `< 0`), because the computed water still includes the volume that will be consumed by the master mix.

**Zero-volume exception**: If `C_target_i = 0` for a component, then `V_i = 0` and the minimum transfer constraint does NOT apply to that component.

---

## 2. media_compiler API

All volume calculations MUST go through the `media_compiler` library. Never perform manual volume arithmetic.

### 2.1 Import Pattern

```python
import sys
sys.path.append('/app/media_compiler')  # Docker path; adjust for local dev
import core
from doe import lhs_maximin
```

### 2.2 `core.find_volumes()`

Single-well volume solver. Solves the linear system `Ax = b` for exact volumes.

```python
core.find_volumes(
    well_volume: float,
    stock_conc_file: str = None,       # Path to CSV with stock concentrations
    target_conc_file: str = None,      # Path to CSV with target concentrations
    components: list = None,           # List of component names
    stock_conc_val: np.ndarray = None, # Array of stock concentrations
    target_conc_val: np.ndarray = None,# Array of target concentrations
    target_conf_df: pd.DataFrame = None,
    culture_ratio: int = 100           # Dilution factor (e.g., 100 means 1% inoculum)
) -> tuple[np.ndarray, pd.DataFrame]
```

**Returns**: `(volumes_array, df)` where:
- `volumes_array`: numpy array of length `n_components + 1` (last element is water volume)
- `df`: DataFrame indexed by Component with columns `Stock Concentration`, `Target Concentration`, `Volumes[uL]`

**Internal assertions** (these will raise if violated):
- All stock concentrations >= 0
- All target concentrations >= 0
- All target concentrations <= stock concentrations
- Sum of concentration ratios <= 1 (volumes fit in the well)
- All solved volumes >= 0
- `abs(sum(volumes) + culture_volume - well_volume) < 0.1`

**Typical usage**:
```python
volumes, df = core.find_volumes(
    well_volume=1500,
    components=component_list,
    stock_conc_val=stock_array,
    target_conc_val=target_array,
    culture_ratio=100
)
```

### 2.3 `core.check_solubility()`

Checks which components have stock concentrations exceeding their solubility limits.

```python
core.check_solubility(
    df: pd.DataFrame,     # Must have column "Stock Concentration"
    solubility: pd.Series, # Solubility values indexed by component
    verbose: bool = True
) -> list
```

**Returns**: List of component names where `Stock Concentration > solubility`.

### 2.4 `core.find_volumes_bulk()`

Batch volume solver with automatic High/Low stock fallback logic. This is the primary function for computing volumes across an entire plate.

```python
core.find_volumes_bulk(
    df_stock: pd.DataFrame,          # Stock concentrations (index=Component)
    df_target_conc: pd.DataFrame,    # Target concentrations per well (index=Well, columns=Components)
    well_volume: float,              # Total well volume
    min_tip_volume: float,           # Minimum accurate transfer volume
    culture_ratio: int,              # Dilution factor
    verbose: int = 0                 # 0=silent, 1=per-iteration, 2=detail
) -> tuple[pd.DataFrame, pd.DataFrame]
```

**`df_stock` required columns**:
- `Low Concentration`: Stock concentration for the dilute stock
- `High Concentration`: Stock concentration for the concentrated stock
- `Dilution Factor`: Ratio `High Concentration / Low Concentration`

**Returns**: `(df_volumes, df_conc_level)` where:
- `df_volumes`: Same shape as `df_target_conc` plus a `Water` column, containing transfer volumes (uL)
- `df_conc_level`: Same shape as `df_target_conc`, containing `'high'` or `'low'` per cell, indicating which stock was used

**Fallback logic** (per well):
1. First attempt: use High stock for all components.
2. If any component yields `0 < V_i < min_tip_volume`, switch that component to Low stock and recalculate.
3. If High+Low mix still fails, try all-Low stocks as last resort.
4. Print success rate at the end.

### 2.5 `core.round_volume()`

Pipette-precision rounding.

```python
core.round_volume(
    volume: np.ndarray,
    well_volume: int
) -> np.ndarray
```

- Volumes < 50 uL: rounded to 1 decimal place (ceiling).
- Volumes >= 50 uL: rounded to integer (ceiling).
- Exception: if rounding would equal `well_volume`, uses standard rounding instead of ceiling.

### 2.6 `doe.lhs_maximin()`

Latin Hypercube Sampling with maximin distance criterion.

```python
from doe import lhs_maximin

lhs_maximin(
    n: int,                           # Number of factors (dimensions)
    samples: int,                     # Number of samples to generate
    iterations: int = 5,              # Number of LHS candidates to evaluate
    random_state: int | np.random.RandomState | None = None
) -> np.ndarray  # shape (samples, n), values in [0, 1]
```

**Returns**: A `(samples x n)` array with values uniformly distributed in `[0, 1]`. The design maximizes the minimum Euclidean distance between all sample pairs.

**Mapping to feasible bounds**:
```python
lhs_design = lhs_maximin(n=len(components), samples=1000, iterations=10, random_state=42)

# Scale from [0, 1] to [Min, Max] for each component
for i, comp in enumerate(components):
    lhs_design[:, i] = bounds_min[i] + lhs_design[:, i] * (bounds_max[i] - bounds_min[i])
```

**WARNING**: NEVER use `pyDOE` or `pyDOE2`. These packages are obsolete, unmaintained, and NOT installed in the environment. The `media_compiler.doe` module contains a local implementation derived from PyDOE3 source code. Always use `from doe import lhs_maximin` (or `from media_compiler.doe import lhs_maximin` depending on sys.path).

---

## 3. Dual-Stock Strategy

To achieve a wide dynamic range (e.g., 0.1x to 10x standard concentration) while respecting the minimum transfer volume `V_MIN`, each variable component is prepared at two stock concentrations: Low and High.

### 3.1 Low Stock Concentration

**Goal**: Reach the minimum bound (`C_MIN`) using exactly `V_MIN`.

**Formula**:
```
C_LOW = (C_MIN * V_WELL) / V_MIN
```

**Constraint**: `C_LOW <= C_HIGH`. If the computed low stock exceeds the high stock, cap it at `C_HIGH`. There is no separate solubility cap on low stocks — the `low <= high` constraint is sufficient because high stocks are already solubility-capped.

**Verification**: After computing, verify feasibility at all-min targets using `core.find_volumes()`.

### 3.2 High Stock Concentration

**Goal**: Reach the maximum bound (`C_MAX`) while maintaining feasibility (`V_water >= 0`).

**Initial guess**: Start with `C_HIGH = C_STD * HIGH_STOCK_MULTIPLIER` (default 100x standard).

**Solubility cap**: `C_HIGH = min(C_HIGH, Solubility * SAFETY_FACTOR)` where `SAFETY_FACTOR` defaults to 0.9 (90%). This cap only applies to high stocks.

**Ensure stocks >= targets**: `C_HIGH = max(C_HIGH, C_MAX)`. If a max target exceeds the solubility cap, a warning is raised.

**Feasibility loop**: If all components at their maximum concentrations cause the total volume to exceed the budget:
1. Calculate the "solubility headroom" ratio for each component: `Ratio_i = (Solubility_i * SAFETY_FACTOR) / C_HIGH_i`.
2. Identify the component with the **largest** ratio (most headroom below solubility).
3. Multiply that component's `C_HIGH` by up to `5` (capped at solubility * SAFETY_FACTOR).
4. Recalculate volumes and repeat until `V_water >= 0` AND all `V_i >= V_MIN`.

```python
MULTIPLIER = 5
while not feasible:
    ratios = (Solubility * SAFETY_FACTOR) / C_HIGH
    # Find component furthest from solubility limit
    comp = argmax(ratios where ratio > MULTIPLIER)
    C_HIGH[comp] = min(C_HIGH[comp] * MULTIPLIER, Solubility[comp] * SAFETY_FACTOR)
    # Recalculate and check feasibility
```

### 3.3 Minimum Volume Correction

After the feasibility loop, if any component still yields `V_i < V_MIN` at the maximum target concentration:

```
C_HIGH_new = C_HIGH_old / (5 * V_MIN / V_i)
```

This forces the required volume up to `5 * V_MIN`, providing a safety buffer. The factor of 5 ensures the volume is comfortably above the minimum even with rounding.

### 3.4 Switch Point and Peak Volume

Robotic transfer volume is NOT monotonic with target concentration due to the High/Low stock switch. This creates a "peak" that must be accounted for in volume budgeting.

**Switch point** -- the target concentration where the High stock volume drops below `V_MIN`:
```
C_SWITCH = (V_MIN * C_HIGH) / V_TOTAL
```

At concentrations below `C_SWITCH`, the system switches to the Low stock.

**Peak volume** -- the volume required just below the switch point using the Low stock:
```
V_PEAK = (V_MIN * C_HIGH) / C_LOW
```

**Volume at maximum bound** (using High stock):
```
V_at_max = (C_MAX * V_TOTAL) / C_HIGH
```

**Budget rule** -- the volume budget for a component must account for the worst case:
```
V_REQUIRED = max(V_at_max, V_PEAK)
```

If `sum(V_REQUIRED) > V_BUDGET`, the maximum bounds must be tightened (reduced multiplier) and the process repeated.

### 3.5 Dilution Factor

The `Dilution Factor` in the stock concentrations DataFrame indicates whether a Low stock is needed:

```
Dilution_Factor = C_HIGH / C_LOW
```

- If `Dilution_Factor = 1`: High and Low stocks are identical; no separate Low stock needed.
- If `Dilution_Factor > 1`: A separate Low stock is required for that component.

---

## 4. ART Configuration

The Automated Recommendation Tool (ART) drives the Bayesian optimization. Configuration is provided via an `art_config.csv` file.

### 4.1 Mandatory Parameters (DBTL 2+)

| Parameter | Type | Description |
|---|---|---|
| `initial_cycle` | bool | `False` for subsequent cycles (default). `True` for first DBTL cycle with no training data. |
| `target_for_optimization` | str | Response metric column name (e.g., `Isoprenol_Production_mgL`). Leave blank if `initial_cycle=True`. |
| `strategy` | str | Optimization goal: `maximize`, `minimize`, or `target` |
| `components_for_optimization` | list[str] | Feature column names (input variables) |
| `bounds_file` | str | Path to `feasible_bounds.csv` (columns: `Variable`, `Min`, `Max`). Optional for DBTL 2+ (ART infers from data). **Required for initial cycle.** |
| `exploitation_recs` | int | Number of designs focused on predicted high-performance regions. Ignored if `initial_cycle=True`. |
| `exploration_recs` | int | Number of designs focused on high-uncertainty regions. Ignored if `initial_cycle=True`. |
| `num_recommendations` | int | Total recommendations for `initial_cycle=True`. Ignored otherwise. |
| `niter` | int | Number of MCMC iterations for parallel tempering (e.g., `100000`). Ignored if `initial_cycle=True`. |
| `burn_in` | int | Initial MCMC iterations to discard. Ignored if `initial_cycle=True`. |
| `tpot_models` | int | Number of TPOT models for automated ML model search. Ignored if `initial_cycle=True`. |
| `cross_val` | bool | Whether to perform cross-validation. Ignored if `initial_cycle=True`. |
| `cross_val_partitions` | int | Number of folds for cross-validation. **MUST be >= 2 even if `cross_val=False`** (see Gotcha #3). Ignored if `initial_cycle=True`. |
| `rel_rec_distance` | float | Minimum diversity distance between recommendations (e.g., `0.5` for 50%) |

### 4.2 Initial Cycle Mode

When `initial_cycle=True`, ART uses Latin Hypercube Sampling to generate an initial experimental design. No ML models are built. Required parameters:

- `initial_cycle=True`
- `input_vars` / `components_for_optimization`
- `num_recommendations` (total designs)
- `bounds` (required — there's no data to infer from)
- `seed`

Not needed: `df`, `response_vars`, `objective`, `niter`, `burn_in`, `cross_val`, `tpot_models`.

**IMPORTANT**: ART's `input_var_type` parameter means **numerical vs categorical** — NOT linear vs log. Do not pass linear/log as `input_var_type`. The linear/log scaling is handled externally via bounds transformation (see Section 4.2.1).

#### 4.2.1 Linear vs Log Bounds Scaling

Each component has a `Scale` column in the bounds template (`linear` or `log`). This controls how the bounds are transformed **before** passing to ART, and how recommendations are **inverse-transformed** after ART returns.

**Mechanism (Option A — transform bounds):**
1. For log-scale components: pass `[log10(Min), log10(Max)]` as bounds to ART.
2. ART's LHS samples evenly in log10 space.
3. After ART: `concentration = 10^(recommended_value)`.

Functions in `stocks_bounds_lib.py`:
- `transform_bounds_for_art(df_bounds, scale_map)` — pre-ART transform
- `inverse_transform_recommendations(df_recs, transform_info)` — post-ART inverse

**Linear** (`Scale=linear`): No transform. Samples evenly in concentration space. Good when Max/Min ≤ 10.

**Log** (`Scale=log`): Log10 transform on bounds. Samples evenly in log space, giving more coverage at the lower end. Good when Max/Min > 10 or when biological effects are proportional to fold-changes.

Example — Glucose [2, 200]:
```
Linear LHS: ~[20, 60, 100, 140, 180]   (sparse below 20)
Log LHS:    ~[3.2, 7.9, 20, 50, 126]   (better low-end coverage)
```

### 4.3 Expert Parameters

| Parameter | Type | Description |
|---|---|---|
| `model_type` | str | ML algorithm (e.g., `GP` for Gaussian Process) |
| `kernel` | str | Covariance function for GPs (e.g., `RBF`, `Matern`) |
| `seed` | int | Random seed for reproducibility |
| `alpha` | float | Exploration-exploitation trade-off weight (0.0 = pure exploitation, 1.0 = pure exploration) |

### 4.4 Dual-Alpha Execution Strategy

To balance immediate performance goals with long-term model improvement, recommendations are generated in two sequential phases within a single run:

**Phase 1 -- Exploitation (`alpha = 0.0`)**:
- Generates designs in regions the model predicts will yield the highest performance.
- Typically 60-70% of plate capacity.

**Phase 2 -- Exploration (`alpha = 1.0`)**:
- Generates designs in regions of high model uncertainty.
- Typically 30-40% of plate capacity.

**Implementation** (steering internal args):
```python
from art.core import RecommendationEngine

# Initialize engine (build model, do NOT recommend yet)
engine = RecommendationEngine(df=training_data, **art_params)

# --- Exploitation phase ---
engine._args.alpha = 0.0
engine._args.num_recommendations = num_exploitation_recs
engine.recommend()
df_exploit = engine.recommendations.copy()

# --- Exploration phase ---
engine._args.alpha = 1.0
engine._args.num_recommendations = num_exploration_recs
engine.recommend()
df_explore = engine.recommendations.copy()

# Combine
df_all_recs = pd.concat([df_exploit, df_explore], ignore_index=True)
```

### 4.5 ART Gotchas -- The 4-Iteration Failure Log

These failure modes were encountered during the Isoprenol Cycle 5 ART run and serve as critical checkpoints for all future automation. Each one was a blocking error that required diagnosis and retry.

#### Gotcha 1: Constructor Argument Mismatch

- **Error**: `TypeError: __init__() got an unexpected keyword argument 'data'`
- **Root cause**: The `RecommendationEngine` constructor accepts `df=`, not `data=`.
- **Fix**: Always use `RecommendationEngine(df=training_dataframe, **params)`.

#### Gotcha 2: Data Must Be MultiIndex DataFrame

- **Error**: Validation failed due to flattened column headers.
- **Root cause**: ART requires training data as a `pd.DataFrame` with a two-level `MultiIndex` on the columns.
- **Fix**: Level 0 must be exactly `"Input Variables"` and `"Response Variables"`. Example construction:

```python
input_cols = pd.MultiIndex.from_product([["Input Variables"], input_var_names])
response_cols = pd.MultiIndex.from_product([["Response Variables"], response_var_names])
columns = input_cols.append(response_cols)
df_multi = pd.DataFrame(data_array, columns=columns)
```

#### Gotcha 3: cross_val_partitions Must Be >= 2

- **Error**: `ValueError: cross_val_partitions must be at least 2`
- **Root cause**: Even when `cross_val=False`, ART's internal schema validation requires `cross_val_partitions` to be an integer >= 2.
- **Fix**: Always set `cross_val_partitions` to at least 2, regardless of `cross_val` setting.

#### Gotcha 4: engine.recommend() Rejects Direct Arguments

- **Error**: `engine.recommend()` rejected `num_recommendations` and `alpha` as keyword arguments.
- **Root cause**: The `recommend()` method does not accept these as parameters. They must be set on the internal args object.
- **Fix**: Update the internal argument object before calling:

```python
engine._args.alpha = 0.0
engine._args.num_recommendations = 10
engine.recommend()  # No arguments
```

---

## 5. Source Plate Configuration

Stocks are organized into three physical source plates, each with specific roles and constraints.

### 5.1 High Plate

- **Contents**: High stock concentrations for ALL components.
- **Format**: 24-well plate (4 rows A-D, 6 columns 1-6).
- **Well naming**: Columns-first order: `A1, B1, C1, D1, A2, B2, C2, D2, A3, ...`
- **Duplicate wells**: Components requiring large total transfer volumes (e.g., NaCl, MgCl2 in the Flaviolin project) may need 2+ source wells. Calculate total volume needed per component across all destination wells and assign additional wells when `total_volume + dead_volume > source_well_max_volume`.

### 5.2 Low Plate

- **Contents**: Low stock concentrations ONLY for components where `Dilution Factor > 1`.
- **Format**: 24-well plate, same well naming convention.
- **Rule**: If `Dilution Factor = 1` (High and Low are identical), that component is NOT placed on the Low Plate.

### 5.3 Fresh Plate

- **Contents**: Components that must be prepared fresh for each run.
- **Typical occupants**:
  - `A1`: Culture (cell inoculum)
  - `B1`: FeSO4 Low stock (unstable in solution)
  - `C1`: FeSO4 High stock (unstable in solution)
- **Rule**: Any component known to degrade or precipitate over time goes on the Fresh Plate.

### 5.4 Volume Tracking

Each source well has a maximum capacity (e.g., 9000 uL for 24-well plates) and a dead volume (e.g., 100 uL). When tracking usage:

```
available_volume = well_max_volume - dead_volume
```

If a component's total required volume exceeds `available_volume`, assign additional wells:

```python
num_wells_needed = ceil(total_volume / well_max_volume)
```

---

## 6. 8-to-4 Robotic Mapping

The liquid handler uses 8-channel simultaneous aspiration to maximize throughput. This creates a specific spatial mapping between source and destination plates.

### 6.1 Source Column Aspiration

The robot aspirates from 8-row columns on the source plate (treated as 96-well format). The designated aspiration columns are:

```
Source columns: 2, 5, 8, 11
```

Each aspiration picks up from rows A-H of the source column simultaneously (8 tips).

### 6.2 8-to-4 Dispense Mapping

Each 8-tip aspiration covers TWO destination columns in the 24-well plate:

```
Tips 1-4 (Source rows A-D) -> Destination Column N (wells A-D)
Tips 5-8 (Source rows E-H) -> Destination Column N+1 (wells A-D)
```

### 6.3 Full Plate Coverage

Three aspirations per component complete the full 24-well destination plate:

| Aspiration | Source Column | Dest Columns |
|---|---|---|
| 1 | Column 2 (rows A-H) | Columns 1 and 2 |
| 2 | Column 5 (rows A-H) | Columns 3 and 4 |
| 3 | Column 8 (rows A-H) | Columns 5 and 6 |

### 6.4 Zero-Volume Resilience

If a destination well requires 0 uL of a component:
- The instruction for that specific tip is **skipped** (no aspiration or dispense for that tip).
- The 8-to-4 spatial mapping remains **fixed** -- other tips in the same aspiration group still dispense to their assigned wells.
- This preserves the synchronized coordinate system.

### 6.5 Component-First Grouping

Instructions are grouped by **component** rather than by well. One component is fully dispensed across the entire plate before moving to the next. This minimizes source plate changes and tip usage.

### 6.6 Pipetting Order

Within each destination well, the strict dispensing order is:

1. **Water** -- always first (prevents osmotic shock)
2. **All media components** -- in consistent order across all wells
3. **Culture** -- always last (cells should contact pre-mixed media)

---

## 7. Validation Protocol

Before committing to a robotic run, generated instructions must be mathematically validated.

### 7.1 Volume Summation Check

For every destination well, sum ALL liquid transfers (stocks, water, base media, inoculum):

```
Constraint: abs(sum(V_i) - V_TOTAL) <= 0.01 uL
```

This catches rounding errors, missing components, and double-counting.

### 7.2 Concentration Back-Calculation

For each component in each well, back-calculate the achieved concentration:

```
C_calc = sum(V_stock_i * C_stock_i) / V_TOTAL
```

Compare against the target:

```
Constraint: abs(C_calc - C_target) / C_target <= 0.001  (0.1% relative error)
```

This catches stock-well misassignment and concentration lookup errors.

### 7.3 Automated Verification

A validation script should iterate through every row of the robotic instruction CSV and independently verify both constraints before the experiment begins. Any discrepancy must be flagged and resolved before proceeding to the robot.

---

## 8. Hitpick XLSX Structure

The final output for robotic control software (e.g., Genapps, Hamilton Venus, Biomek) is an XLSX workbook with a specific structure.

### 8.1 Sheet 1: Transfers

All transfers for all plates, consolidated into a single table.

| Column | Description |
|---|---|
| `Source_Plate` | Name of the source plate (e.g., `High_Plate`, `Low_Plate`, `Fresh_Plate`) |
| `Source_Well` | Well position on the source plate (e.g., `A1`, `B3`) |
| `Dest_Plate` | Name of the destination plate (e.g., `dest1`, `dest2`) |
| `Dest_Well` | Well position on the destination plate |
| `Transfer_volume` | Volume to transfer (uL) |

**Rules**:
- All transfers (Water, Stocks, Inoculum, Salts) for ALL plates must be in this single sheet.
- Internal plate IDs (P1, P2) must be mapped to actual deck names.
- Sorted by `Component -> Aspiration_Group -> Sequence` if using 8-to-4 batching.

### 8.2 Sheet 2: Labware Mapping

A lookup table mapping every unique plate name to its physical labware type.

| Column | Description |
|---|---|
| `Plate_name` | Every unique plate name appearing in Sheet 1 (both Source and Dest) |
| `Labware` | Physical labware identifier from the compatible labware list |

**Population logic**: Extract all unique plate names from the `Source_Plate` and `Dest_Plate` columns of Sheet 1. Assign labware types from the master compatibility list (which may be on Sheet 3 of a template workbook or provided separately).

### 8.3 Sheet 3: Reference (Optional)

A complete list of all compatible labware for the specific robotic deck. Used as a lookup source when populating Sheet 2.

---

## 9. Input File Schemas

Three user-confirmed input files are required before Phase 2 can begin. Templates for each are in the `templates/` directory.

### 9.1 `experiment_config.csv`

| Parameter | Required? | Default | Description |
|---|---|---|---|
| `V_TOTAL` | **Yes** | -- | Total well volume (uL) |
| `CULTURE_FACTOR` | **Yes** | -- | Culture dilution ratio (e.g. 100 means 1% inoculum: `V_INOCULUM = V_TOTAL / CULTURE_FACTOR`) |
| `V_INOCULUM` | No | `V_TOTAL / CULTURE_FACTOR` | Inoculum volume (uL). Optional — derived from `CULTURE_FACTOR` if omitted. Provide only if you want to override the derived value. |
| `BASE_MEDIA_VOL` | No | 0 | Volume of pre-made master mix added to every well (uL). Components inside the master mix are NOT listed in `standard_recipe.csv`. Set to 0 if all components are pipetted individually. |
| `MIN_TRANSFER` | **Yes** | -- | Minimum pipette transfer (uL) |
| `DEFAULT_MIN_MULTIPLIER` | No | 0.1 | Lower bound as fraction of standard |
| `DEFAULT_MAX_MULTIPLIER` | No | 10.0 | Upper bound as multiple of standard |
| `DEFAULT_HIGH_STOCK_MULTIPLIER` | No | 100.0 | Initial high stock multiplier |
| `SOLUBILITY_SAFETY_FACTOR` | No | 0.9 | Fraction of solubility for stock cap |

### 9.2 `standard_recipe.csv`

| Column | Description |
|---|---|
| `Component` | Component name. Only list components the robot pipettes individually. Components inside `BASE_MEDIA_VOL` are not listed here. |
| `Concentration` | Standard (1x) concentration for this component |
| `Solubility` | Solubility limit in the same units as Concentration |
| `Variable` | `Y` if ART optimizes this component's concentration. `N` if the robot pipettes it at standard concentration every well (e.g., an antibiotic). |

**Key invariant**: `bounds.csv` contains only `Variable=Y` components. `Variable=N` components always appear at their standard concentration and are never passed to ART.

### 9.3 `bounds.csv`

| Column | Description |
|---|---|
| `Component` | Component name (must match standard recipe) |
| `Min_Multiplier` | Lower bound as fraction of standard (e.g. 0.1 = 10% of standard) |
| `Max_Multiplier` | Upper bound as multiple of standard (e.g. 5.0 = 5x standard) |
| `Min_Concentration` | Lower bound as absolute concentration (takes precedence over multiplier) |
| `Max_Concentration` | Upper bound as absolute concentration (takes precedence over multiplier) |
| `Scale` | `linear` or `log`. Controls how bounds are transformed for ART LHS sampling. Default: `linear`. |

**Resolution rules**: For each component and each bound:
1. If absolute concentration is set, use it.
2. Else if multiplier is set, compute `concentration = multiplier * standard`.
3. Else use the default multiplier from `experiment_config.csv`.

Multipliers and concentrations can be mixed across components (e.g., Glucose by multiplier, NaCl by concentration).

### 9.4 Output File Schemas

**`stock_concentrations.csv`**:

| Column | Description |
|---|---|
| `Component` | Component name (index) |
| `Low Concentration` | Low stock concentration |
| `High Concentration` | High stock concentration |
| `Dilution Factor` | `High / Low` ratio |

**`feasible_bounds.csv`**:

| Column | Description |
|---|---|
| `Variable` | Component name |
| `Min` | Minimum feasible target concentration |
| `Max` | Maximum feasible target concentration |

---

## Appendix A: Quick Formula Reference Card

```
V_i            = (C_target_i * V_TOTAL) / C_stock_i
V_water        = V_TOTAL - V_INOCULUM - V_BASE_MEDIA - sum(V_i for all listed components)
feasible       = V_water >= 0  (equivalently: df_volumes['Water'] >= BASE_MEDIA_VOL)
C_LOW          = (C_MIN * V_WELL) / V_MIN
C_SWITCH       = (V_MIN * C_HIGH) / V_TOTAL
V_PEAK         = (V_MIN * C_HIGH) / C_LOW
V_at_max       = (C_MAX * V_TOTAL) / C_HIGH
V_REQUIRED     = max(V_at_max, V_PEAK)
Dilution_Factor = C_HIGH / C_LOW
```

## Appendix B: Deprecated Libraries -- DO NOT USE

| Package | Status | Replacement |
|---|---|---|
| `pyDOE` | **NEVER use** -- obsolete, unmaintained, NOT installed | `media_compiler.doe.lhs_maximin` |
| `pyDOE2` | **NEVER use** -- obsolete, NOT installed | `media_compiler.doe.lhs_maximin` |

The `media_compiler.doe` module contains a local implementation derived from PyDOE3 source code, properly tested and vendored into the project. This is the ONLY LHS implementation that should be used.
