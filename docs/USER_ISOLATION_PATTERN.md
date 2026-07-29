# User Isolation Pattern in ART Bundle Plugin

**Version**: 1.0  
**Date**: July 28, 2026  
**Status**: Reference Documentation

---

## Overview

The ART Bundle Plugin uses a **user email + project slug** pattern to enforce strict isolation between different users and their projects. This ensures that:
- ✅ Scientists' data remains private
- ✅ Projects can be shared by name without risk of collision
- ✅ Multi-user workflows are supported
- ✅ Data cannot be accidentally accessed across users

---

## Path Structure

All project files are organized under:

```
/shared/user_impl_alpha/{user_email}/{project_slug}/
```

**Example paths**:
```
/shared/user_impl_alpha/alice@example.com/flaviolin_opt_v1/
/shared/user_impl_alpha/bob@example.com/flaviolin_opt_v1/  (different user, separate isolation)
/shared/user_impl_alpha/alice@example.com/flaviolin_opt_v2/  (different project, same user)
```

### Directory Structure Within Project

```
/shared/user_impl_alpha/{user_email}/{project_slug}/
├── scripts/                    # Generated Python scripts
│   ├── generate_media_instructions.py
│   ├── run_art_optimization.py
│   └── validate_lh_instructions.py
├── data/                       # Input CSV files
│   ├── standard_recipe.csv
│   ├── training_data.csv
│   └── experiment_config.csv
├── outputs/                    # Output files
│   ├── robotic_instructions.csv
│   ├── recommendations_current_cycle.csv
│   └── stock_concentrations.csv
└── config/                     # Configuration files
    ├── art_config.csv
    └── experiment_constraints.json
```

---

## User & Project Context Variables

When dispatched, agents receive two key parameters:

### `user_email`
- **Type**: String (email format)
- **Example**: `alice@example.com`, `scientist@lab.edu`
- **Purpose**: Identifies the scientist, enables multi-user isolation
- **Used by**: All agents, all file operations

### `project_slug`
- **Type**: String (lowercase, alphanumeric, hyphens only)
- **Example**: `flaviolin_opt_v1`, `media_opt_cycle2`
- **Pattern**: `^[a-z0-9_-]+$` (alphanumeric, underscores, hyphens)
- **Purpose**: Identifies the specific experiment, enables multiple projects per user
- **Used by**: All agents, all file operations

---

## MCP Tools for User Isolation

**⚠️ IMPORTANT**: For exact tool signatures, return types, and optional parameters, consult `mcp_art_server.py` in ART_MCP as the single source of truth. The examples below show the core isolation patterns; implementation details may vary.

### ✅ USER-AWARE TOOLS

These tools actively enforce user isolation by checking permissions:

#### `get_user_projects(user_email: str)`
- **Purpose**: List all projects for a specific user
- **Safety**: Cannot list other users' projects
- **Use**: To show users their previous projects
```python
result = get_user_projects(user_email="alice@example.com")
# Returns info about alice's projects
```

#### `upload_script(filename: str, content: str, project_slug: str, user_email: str)`
- **Purpose**: Save a Python script to user's project
- **Safety**: Automatically places in `/shared/user_impl_alpha/{user_email}/{project_slug}/scripts/`
- **Use**: After generating scripts
```python
upload_script(
    filename="generate_media_instructions.py",
    content=script_content,
    project_slug="flaviolin_opt_v1",
    user_email="alice@example.com"
)
```

#### `upload_data_file(filename: str, content: str, project_slug: str, user_email: str)`
- **Purpose**: Save a data file (CSV, JSON, etc.) to user's project
- **Safety**: Automatically places in user's project directory
- **Use**: After generating configuration or data files
```python
upload_data_file(
    filename="robotic_instructions.csv",
    content=csv_content,
    project_slug="flaviolin_opt_v1",
    user_email="alice@example.com"
)
```

#### `list_shared_files(user_email: str, project_slug: str, ...)`
- **Purpose**: List files in a user's project
- **Safety**: Cannot list other users' files
- **Use**: To discover what files exist in a project
```python
result = list_shared_files(
    user_email="alice@example.com",
    project_slug="flaviolin_opt_v1"
)
# Returns files only from alice's project
```

#### `download_file(filepath: str)`
- **Purpose**: Download a file from a project
- **Safety**: Only accessible if user has permission (path-based isolation)
- **Use**: To retrieve previously generated files
```python
result = download_file(
    filepath="/shared/user_impl_alpha/alice@example.com/flaviolin_opt_v1/outputs/robotic_instructions.csv"
)
```

### ⚪ GENERAL TOOLS

These tools don't require user_email directly, but isolation is enforced via file paths:

#### `execute_code(script_path: str)`
- **Purpose**: Run Python code in art-core container
- **Safety**: Isolation determined by the script_path (must be in user's project directory)
- **Use**: To execute generated scripts
```python
result = execute_code(
    script_path="/shared/user_impl_alpha/alice@example.com/flaviolin_opt_v1/scripts/art_optimization.py"
)
```

---

## Implementing User Isolation in Agents

### Pattern 1: Construct Paths Dynamically

```python
# ❌ WRONG - Hardcoded path
script_path = "/app/my_script.py"

# ✅ CORRECT - Dynamic user context
user_email = "alice@example.com"
project_slug = "flaviolin_opt_v1"
project_root = f"/shared/user_impl_alpha/{user_email}/{project_slug}"
script_path = f"{project_root}/scripts/my_script.py"
```

### Pattern 2: Use USER-AWARE Tools When Available

```python
# ❌ WRONG - Manually managing paths
with open(f"/shared/user_impl_alpha/{user_email}/{project_slug}/data/result.csv") as f:
    content = f.read()

# ✅ CORRECT - Using MCP tool
content = download_file(
    filepath=f"/shared/user_impl_alpha/{user_email}/{project_slug}/data/result.csv"
)
```

### Pattern 3: Validate User Context Exists

```python
# At the start of any workflow
if not user_email or not project_slug:
    raise ValueError("user_email and project_slug are required")

# Never make assumptions about user/project
project_root = f"/shared/user_impl_alpha/{user_email}/{project_slug}"
```

---

## Key Rules (Inviolable)

1. ✅ **Always construct paths with user context**
   - Use `{user_email}` and `{project_slug}` in every file path
   - Never write to `/app/` directly
   - Never write to paths outside `/shared/user_impl_alpha/`

2. ✅ **Ask for user context if missing**
   - If user_email is not provided, ask for it explicitly
   - If project_slug is not provided, ask for it explicitly
   - Do NOT guess or use defaults

3. ✅ **Use USER-AWARE tools for isolation enforcement**
   - Use `get_user_projects()` to show projects
   - Use `upload_script()` and `upload_data_file()` to save files
   - Use `list_shared_files()` to discover files
   - Use `download_file()` to retrieve files

4. ✅ **Validate input files respect user isolation**
   - If user provides a file path, verify it's within their project
   - Never read from other users' projects

---

## Example: Complete Workflow with Isolation

```python
# Phase 1: Gather context
user_email = "alice@example.com"
project_slug = "flaviolin_opt_v1"
project_root = f"/shared/user_impl_alpha/{user_email}/{project_slug}"

# Phase 2: Construct paths
input_file = f"{project_root}/data/standard_recipe.csv"
output_file = f"{project_root}/outputs/robotic_instructions.csv"
script_file = f"{project_root}/scripts/generate_instructions.py"

# Phase 3: Generate script
script_content = f"""
import pandas as pd
recipe = pd.read_csv('{input_file}')
# ... process ...
results.to_csv('{output_file}', index=False)
"""

# Phase 4: Save script using USER-AWARE tool
upload_script(
    filename="generate_instructions.py",
    content=script_content,
    project_slug=project_slug,
    user_email=user_email
)

# Phase 5: Execute using script path
result = execute_code(script_path=script_file)

# Phase 6: Verify output using USER-AWARE tool
files = list_shared_files(
    user_email=user_email,
    project_slug=project_slug
)
if "robotic_instructions.csv" in [f.split('/')[-1] for f in files]:
    print("✅ Output saved successfully")
```

---

## Multi-User Example

Two scientists working on the same project name:

```
alice@example.com/flaviolin_opt_v1/     ← Alice's project
├── data/
│   ├── alice_recipe.csv
│   └── alice_results.csv
└── outputs/
    ├── alice_recommendations.csv
    └── alice_robotic_instructions.csv

bob@example.com/flaviolin_opt_v1/       ← Bob's project (same name, different user)
├── data/
│   ├── bob_recipe.csv
│   └── bob_results.csv
└── outputs/
    ├── bob_recommendations.csv
    └── bob_robotic_instructions.csv
```

**Neither user can see the other's files** because the path structure includes the email.

---

## Troubleshooting

**Q: "File not found" error even though I think the file exists**
- Check: Are you constructing the path with the correct user_email and project_slug?
- Check: Is the file path within `/shared/user_impl_alpha/{user_email}/{project_slug}/`?

**Q: "Permission denied" when accessing a file**
- Check: Is the file in your own project directory (your email)?
- Check: Are you using the correct email (case-sensitive)?

**Q: Can I access another user's files?**
- No. The path structure enforces strict isolation. You can only access files in `/shared/user_impl_alpha/{your_email}/{your_project}/`

**Q: What if I have multiple projects?**
- Create a different project_slug for each (e.g., `flaviolin_opt_v1`, `flaviolin_opt_v2`)
- All projects are isolated within your email's namespace

---

## Enforcement Mechanism

The isolation is enforced at multiple levels:

1. **Path-based**: Files stored in `/shared/user_impl_alpha/{email}/{slug}/` are naturally isolated
2. **Tool-based**: USER-AWARE tools check permissions before returning data
3. **Container-based**: Scripts execute in a sandboxed art-core container with filesystem access controlled by the path

This multi-layered approach ensures isolation is maintained even if one layer is compromised.

---

*End of User Isolation Pattern Reference*
