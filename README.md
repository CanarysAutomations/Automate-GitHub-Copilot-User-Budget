# Automate GitHub Copilot User Budget (UBB)

This GitHub Action automates the user budgets allocation from a CSV file inside your repository with your GitHub Enterprise Billing account.

# Prerequisite

GitHub Token with enterprise admin or billing manager permission.

## Features

- **Automatic Budget Management**: 
  - If a user's budget is missing, it is **created**.
  - If a user's budget exists but has a different amount, it is **updated**.
  - If the budget matches the CSV file, it is skipped (left **unaltered**).
- **Pagination Support**: Automatically pages through large sets of enterprise budgets (50 items per page) to retrieve all existing records.
- **Audit Logging**: Generates a execution report (`budget-run-report.md` and `allocation.csv`) detailing created, updated, unaltered, and failed records, and publishes it directly to the GitHub Action run overview page.

---

## Workflow Inputs

When triggering the action manually, the following parameters are available:

| Input Name | Description | Required | Default Value |
| :--- | :--- | :--- | :--- |
| `budgets_file` | The path to the CSV budgets file inside the repository. | Yes | `budgets.csv` |
| `enterprise_slug` | The slug version of your GitHub Enterprise name. | Yes | *None* |
| `api_version` | The GitHub API version header. | Yes | `2026-03-10` |

---

## GitHub Setup & Configuration

Follow these configuration steps in your GitHub repository:

### 1. Set Repository Secrets
1. Navigate to your repository -> **Settings** -> **Secrets and variables** -> **Actions**.
2. Click **New repository secret** and add:
   - `ENTERPRISE_BILLING_TOKEN`: Generate A Personal Access Token (PAT). The authenticated user must be an enterprise admin or billing manager (needs `manage_billing:copilot` scope).
3. Add `ENTERPRISE_SLUG` as a repository secret or variable so it is automatically provided.

### 2. Grant Workflow Write Permissions
The action commits the audit report (`budget-run-report.md`) back to the repository so you have a versioned audit trail.
1. Navigate to your repository -> **Settings** -> **Actions** -> **General**.
2. Scroll to **Workflow permissions**, select **Read and write permissions**.
3. Click **Save**.

---

## Usage

### 1. CSV File Layout
Create a CSV file named `budgets.csv` in the root of your repository. The CSV must contain at least a **User** column and a **Budget** column:

```csv
User,Budget
tim,150.00
johndoe,120.00
unaltereduser,200.00
```

### 2. Triggering the Sync
- **Manual Run**: Navigate to the **Actions** tab, select the **Automate GitHub Copilot User Budget (UBB)** workflow, click **Run workflow**, verify the inputs, and start the execution.
- **Automated Run**: The workflow runs automatically whenever you push updates to the `budgets.csv` file.

### Complete YAML pipeline
```
name: Budget Allocation
on:
  push:
    branches: [ "main" ]
  paths:
   - 'budgets.csv'

  workflow_dispatch:

jobs:
  Allocation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Automate GitHub Copilot User Budget
        uses: CanarysAutomations/Automate-GitHub-Copilot-User-Budget@v1
        with:
          # Path to the Excel budgets file
          budgets_file: 'budgets.csv'
          # GitHub Enterprise Slug
          enterprise_slug: 'ENTERPRISE_SLUG'
          # GitHub API Version
          api_version: '2026-03-10'
          # Personal Access Token with enterprise billing permissions
          github_token: ${{ secrets.ENTERPRISE_BILLING_TOKEN }}
      
      - name: Upload Budget Reports
            uses: actions/upload-artifact@v4
            with:
                name: budget-allocation-report
                path: |
                  allocation.csv
                  budget-run-report.md

```
