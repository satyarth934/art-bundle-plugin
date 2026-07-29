# Liquid Handler Technical Reference

Authoritative reference for the `liquid-handler-specialist` agent. Covers every phase of the liquid-handling pipeline, from stock calculation through robotic output. All volume calculations MUST go through `media_compiler`. Never perform manual volume arithmetic.

---

## Phase 2: Stocks and Bounds Calculation

### media_compiler Import Pattern

```python
import sys
sys.path.insert(0, '/app/media_compiler')
import core
from doe import lhs_maximin
```

### Dual-Stock Strategy

Each variable component is prepared at two stock concentrations (Low and High) to cover a wide dynamic range while respecting the minimum pipette transfer volume `V_MIN`.

#### Key Formulas

```
V_BUDGET        = V_TOTAL - V_INOCULUM - V_BASE
V_i             = (C_target_i * V_TOTAL) / C_stock_i
V_water         = V_BUDGET - sum(V_i)

C_LOW           = (C_MIN * V_WELL) / V_MIN          # cap at C_HIGH
C_SWITCH        = (V_MIN * C_HIGH) / V_TOTAL         # switch point
V_PEAK          = (V_MIN * C_HIGH) / C_LOW           # worst-case near switch
V_at_max        = (C_MAX * V_TOTAL) / C_HIGH
V_REQUIRED      = max(V_at_max, V_PEAK)              # budget check
Dilution_Factor = C_HIGH / C_LOW
```

#### Low Stock

Goal: reach `C_MIN` using exactly `V_MIN`.

```
C_LOW = (C_MIN * V_WELL) / V_MIN
```

Constraint: `C_LOW <= C_HIGH`. If computed value exceeds C_HIGH, cap at C_HIGH. No solubility cap on low stocks — the `low <= high` constraint is sufficient.

#### High Stock

1. Initial guess: `C_HIGH = C_STD * HIGH_STOCK_MULTIPLIER` (default 100x standard)
2. Solubility cap: `C_HIGH = min(C_HIGH, Solubility * SAFETY_FACTOR)` (SAFETY_FACTOR default 0.9)
3. Ensure stocks ≥ targets: `C_HIGH = max(C_HIGH, C_MAX)`
4. Feasibility loop — if all-max targets exceed volume budget:
   - Compute headroom ratios: `Ratio_i = (Solubility_i * SAFETY_FACTOR) / C_HIGH_i`
   - Identify component with **largest** ratio (most headroom)
   - Multiply that component's C_HIGH by up to 5 (capped at solubility * SAFETY_FACTOR)
   - Repeat until `V_water >= 0` AND all `V_i >= V_MIN`
5. Minimum volume correction — if any `V_i < V_MIN` at C_MAX after the loop:
   ```
   C_HIGH_new = C_HIGH_old / (5 * V_MIN / V_i)
   ```

#### Dilution Factor

```
Dilution_Factor = C_HIGH / C_LOW
```

- `== 1`: High and Low stocks are identical; no separate Low stock needed.
- `> 1`: Separate Low stock required for this component.

---

## Phase 3: LHS Feasibility Verification

### `doe.lhs_maximin()`

```python
lhs_maximin(
    n: int,                  # Number of factors (dimensions)
    samples: int,            # Number of samples
    iterations: int = 5,     # LHS candidates to evaluate
    random_state: int | None = None
) -> np.ndarray              # shape (samples, n), values in [0, 1]
```

**WARNING**: NEVER use `pyDOE` or `pyDOE2`. Use only `from doe import lhs_maximin`.

Scaling from [0, 1] to feasible bounds:
```python
lhs_unit = lhs_maximin(n=len(components), samples=1000, iterations=10, random_state=42)
for i, comp in enumerate(components):
    lhs_design[:, i] = bounds_min[i] + lhs_unit[:, i] * (bounds_max[i] - bounds_min[i])
```

### `core.find_volumes_bulk()`

Batch volume solver with automatic High/Low stock fallback logic. Used to verify that LHS designs are feasible.

```python
core.find_volumes_bulk(
    df_stock: pd.DataFrame,        # index=Component; columns: Low Concentration, High Concentration, Dilution Factor
    df_target_conc: pd.DataFrame,  # index=Well, columns=Components
    well_volume: float,
    min_tip_volume: float,
    culture_ratio: int,
    verbose: int = 0               # 0=silent, 1=per-iteration, 2=detail
) -> tuple[pd.DataFrame, pd.DataFrame]
```

Returns `(df_volumes, df_conc_level)`:
- `df_volumes`: same shape as `df_target_conc` plus a `Water` column (transfer volumes in uL)
- `df_conc_level`: `'high'` or `'low'` per cell

Fallback logic (per well):
1. First attempt: High stock for all components.
2. If any `0 < V_i < V_MIN`, switch that component to Low stock and recalculate.
3. If High+Low still fails, try all-Low stocks.

Feasibility indicator: `Water < 0` means infeasible.

---

## Phase 5: Target Concentrations → Transfer Volumes

### `core.find_volumes()`

Single-well volume solver.

```python
core.find_volumes(
    well_volume: float,
    components: list,
    stock_conc_val: np.ndarray,
    target_conc_val: np.ndarray,
    culture_ratio: int = 100
) -> tuple[np.ndarray, pd.DataFrame]
```

Returns `(volumes_array, df)`:
- `volumes_array`: length `n_components + 1`, last element is water volume
- `df`: indexed by Component; columns: `Stock Concentration`, `Target Concentration`, `Volumes[uL]`

### `core.round_volume()`

```python
core.round_volume(volume: np.ndarray, well_volume: int) -> np.ndarray
```

- Volumes < 50 uL: ceiling to 1 decimal place
- Volumes ≥ 50 uL: ceiling to integer
- Exception: if rounded value equals `well_volume`, use standard rounding

---

## Phase 6: Robotic Instruction Generation (8-to-4 Mapping)

### Source Plate Layout

Three physical source plates:

| Plate | Contents |
|---|---|
| **High Plate** | High stock concentrations for ALL components. 24-well (4 rows A-D, 6 columns 1-6). Well order: A1, B1, C1, D1, A2, B2, ... |
| **Low Plate** | Low stocks ONLY where `Dilution Factor > 1`. Same format. |
| **Fresh Plate** | Components that degrade (e.g., inoculum at A1, unstable stocks). |

Volume tracking per source well:
```
available_volume = well_max_volume - dead_volume
num_wells_needed = ceil(total_volume / well_max_volume)
```

### 8-to-4 Dispense Mapping Algorithm

The robot aspirates simultaneously from 8-row source columns. Designated source columns: **2, 5, 8, 11**.

Each 8-tip aspiration covers two destination columns in the 24-well plate:
```
Tips 1–4 (Source rows A–D)  →  Destination Column N
Tips 5–8 (Source rows E–H)  →  Destination Column N+1
```

Full plate coverage (3 aspirations per component):

| Aspiration | Source Column | Destination Columns |
|---|---|---|
| 1 | Column 2 (rows A–H) | Columns 1 and 2 |
| 2 | Column 5 (rows A–H) | Columns 3 and 4 |
| 3 | Column 8 (rows A–H) | Columns 5 and 6 |

### Zero-Volume Resilience

If a destination well requires 0 uL of a component:
- Skip the instruction for that specific tip (no aspiration/dispense).
- The 8-to-4 spatial mapping stays fixed — other tips in the same aspiration group still dispense normally.

### Pipetting Order

Within each well, strictly:
1. **Water** — always first (prevents osmotic shock)
2. **All media components** — consistent order across all wells
3. **Culture (inoculum)** — always last

### Component-First Grouping

Group instructions by **component**, not by well. Fully dispense one component across the entire plate before moving to the next. This minimizes source plate changes and tip usage.

---

## Phase 7: Validation

### Volume Summation Check

For every destination well:
```
Constraint: abs(sum(V_i) - V_TOTAL) <= 0.01 uL
```

Catches rounding errors, missing components, and double-counting.

### Concentration Back-Calculation

For each component in each well:
```
C_calc = sum(V_stock_j * C_stock_j) / V_TOTAL
Constraint: abs(C_calc - C_target) / C_target <= 0.001   (0.1% relative error)
```

Catches stock-well misassignment and concentration lookup errors.

Both checks must pass for every well before proceeding to the robot.

---

## Phase 8: Hitpick XLSX Output

Final output for robotic control software (Genapps, Hamilton Venus, Biomek). Three sheets:

### Sheet 1: Transfers

All transfers for all plates in a single table.

| Column | Description |
|---|---|
| `Source_Plate` | Source plate name (e.g., `High_Plate`, `Low_Plate`, `Fresh_Plate`) |
| `Source_Well` | Well on the source plate (e.g., `A1`) |
| `Dest_Plate` | Destination plate name (e.g., `dest1`, `dest2`) |
| `Dest_Well` | Well on the destination plate |
| `Transfer_volume` | Volume to transfer (uL) |

Rules:
- All transfers (Water, Stocks, Inoculum, Base media) for ALL plates in this single sheet.
- Internal plate IDs (P1, P2) must be mapped to actual deck names.
- Sorted by `Component → Aspiration_Group → Sequence`.

### Sheet 2: Labware Mapping

| Column | Description |
|---|---|
| `Plate_name` | Every unique plate name from Sheet 1 (both Source and Dest) |
| `Labware` | Physical labware identifier from the compatible labware list |

Populate by extracting all unique plate names from `Source_Plate` and `Dest_Plate` in Sheet 1, then assigning labware types from the master compatibility list.

### Sheet 3: Reference (Optional)

Complete list of compatible labware for the robotic deck. Used as lookup source when populating Sheet 2.
