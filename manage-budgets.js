const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

// Configuration loaded from environment variables (supporting standard env and GitHub Action inputs)
const TOKEN = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN;
const ENTERPRISE = process.env.ENTERPRISE_SLUG || process.env.INPUT_ENTERPRISE_SLUG;
const FILE_PATH = process.env.BUDGETS_FILE_PATH || process.env.INPUT_BUDGETS_FILE || 'budgets.csv';
const API_VERSION = process.env.API_VERSION || process.env.INPUT_API_VERSION || '2026-03-10';
const API_BASE_URL = `https://api.github.com/enterprises/${ENTERPRISE}/settings/billing/budgets`;

// Reports and Logging collections
const runSummary = {
  dateTime: new Date().toISOString(),
  created: [],
  updated: [],
  unaltered: [],
  failed: []
};

/**
 * Robustly parses the CSV file and extracts User and Budget values
 * @param {string} filePath Path to the CSV file
 * @returns {Array<{user: string, budget: number}>} List of users and their budgets
 */
function parseCSV(filePath) {
  console.log(`Reading CSV file from path: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(worksheet);
  
  const parsedData = [];

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    let userVal = null;
    let budgetVal = null;

    for (const key of Object.keys(row)) {
      const normalizedKey = key.trim().toLowerCase();
      if (normalizedKey === 'user' || normalizedKey === 'username' || normalizedKey === 'name') {
        userVal = row[key];
      } else if (
        normalizedKey === 'budget' || 
        normalizedKey === 'amount' || 
        normalizedKey === 'budget amount' || 
        normalizedKey === 'budget_amount'
      ) {
        budgetVal = row[key];
      }
    }

    if (userVal !== null && budgetVal !== null) {
      const username = String(userVal).trim();
      const budget = parseFloat(budgetVal);

      if (!username) {
        console.warn(`Row ${idx + 2}: Skipped because username is empty.`);
        continue;
      }
      if (isNaN(budget)) {
        console.warn(`Row ${idx + 2} (${username}): Skipped because budget is not a valid number: "${budgetVal}"`);
        continue;
      }

      parsedData.push({ user: username, budget: budget });
    } else {
      console.warn(`Row ${idx + 2}: Skipped because User or Budget column could not be identified. Row keys: ${Object.keys(row).join(', ')}`);
    }
  }

  console.log(`Successfully parsed ${parsedData.length} records from CSV.`);
  return parsedData;
}

/**
 * Fetches all existing budgets from GitHub with pagination support
 * @param {string} baseUrl The API endpoint URL
 * @param {object} headers API headers
 * @returns {Promise<Map<string, object>>} Map of user-scoped budgets keyed by username
 */
async function fetchExistingBudgets(baseUrl, headers) {
  console.log('Fetching existing budgets from GitHub Enterprise Billing API...');
  const userBudgetsMap = new Map();
  let page = 1;
  const perPage = 10; // Use max possible per page to minimize API calls
  let hasMore = true;

  while (hasMore) {
    const url = `${baseUrl}?page=${page}&per_page=${perPage}`;
    console.log(`Fetching page ${page}: GET ${url}`);
    
    const response = await fetch(url, { method: 'GET', headers });
    
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to fetch budgets (HTTP ${response.status}): ${errText}`);
    }

    const data = await response.json();
    const budgetsList = data.budgets || [];
    
    console.log(`Retrieved ${budgetsList.length} budget items on page ${page}.`);

    if (budgetsList.length === 0) {
      hasMore = false;
      break;
    }

    for (const budget of budgetsList) {
      // Filter by user budget scope
      if (budget.budget_scope === 'user') {
        // The user scope maps the target user name to budget_entity_name
        const username = budget.budget_entity_name ? budget.budget_entity_name.toLowerCase() : null;
        if (username) {
          userBudgetsMap.set(username, budget);
        }
      }
    }

    if (budgetsList.length < perPage) {
      hasMore = false;
    } else {
      page++;
    }
  }

  console.log(`Found ${userBudgetsMap.size} existing user budgets.`);
  return userBudgetsMap;
}

/**
 * Creates a new user budget
 */
async function createBudget(baseUrl, headers, username, amount) {
  console.log(`[CREATE] Creating new budget of $${amount.toFixed(2)} for user: ${username}`);
  const payload = {
    budget_amount: amount,
    budget_scope: 'user',
    user: username,
    prevent_further_usage: true,
    budget_product_sku: 'premium_requests',
    budget_type: 'BundlePricing',
    budget_alerting: { will_alert: false, alert_recipients: [] }
  };

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText}`);
  }

  const result = await response.json();
  console.log(`[CREATE SUCCESS] Budget created for user ${username}. Budget ID: ${result.id}`);
  return result;
}

/**
 * Updates an existing user budget
 */
async function updateBudget(baseUrl, headers, budgetId, username, amount) {
  console.log(`[UPDATE] Updating budget of user ${username} to $${amount.toFixed(2)} (Budget ID: ${budgetId})`);
  const payload = {
    budget_amount: amount,    
    user: username,
    prevent_further_usage: true,
    budget_alerting: { will_alert: false, alert_recipients: [] }
  };

  const url = `${baseUrl}/${budgetId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText}`);
  }

  const result = await response.json();
  console.log(`[UPDATE SUCCESS] Budget updated for user ${username}.`);
  return result;
}

/**
 * Formats a value as a float to 2 decimal places if it's a number
 * @param {any} val Value to format
 * @returns {string} Formatted string
 */
function formatAmount(val) {
  const num = parseFloat(val);
  return isNaN(num) ? String(val) : num.toFixed(2);
}

/**
 * Parses an existing allocation.csv file if it exists in the workspace
 * @param {string} filePath Path to the CSV file
 * @returns {Map<string, object>} Map of user-scoped allocations keyed by username (lowercased)
 */
function parseAllocationCSV(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) {
    return map;
  }
  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet);
    
    for (const row of rows) {
      let userVal = null;
      let budgetVal = null;
      let statusVal = null;
      let fromVal = null;
      let toVal = null;
      
      for (const key of Object.keys(row)) {
        const normKey = key.trim().toLowerCase();
        if (normKey === 'user') userVal = row[key];
        else if (normKey === 'budget') budgetVal = row[key];
        else if (normKey === 'status') statusVal = row[key];
        else if (normKey === 'from') fromVal = row[key];
        else if (normKey === 'to') toVal = row[key];
      }
      
      if (userVal !== null) {
        const username = String(userVal).trim();
        map.set(username.toLowerCase(), {
          user: username,
          budget: formatAmount(budgetVal),
          status: statusVal,
          from: formatAmount(fromVal),
          to: formatAmount(toVal)
        });
      }
    }
  } catch (err) {
    console.warn(`Could not parse existing allocation.csv, starting fresh: ${err.message}`);
  }
  return map;
}

/**
 * Creates or updates allocation.csv with the run results and updates Actions step summary
 */
function generateAllocationCSV() {
  const reportPath = 'allocation.csv';
  console.log(`Generating/updating allocation CSV at: ${reportPath}`);

  // 1. Read existing allocation.csv if it exists
  const allocationMap = parseAllocationCSV(reportPath);

  // 2. Update/upsert the map with current run's allocations
  // Process created
  for (const item of runSummary.created) {
    allocationMap.set(item.user.toLowerCase(), {
      user: item.user,
      budget: formatAmount(item.budget),
      status: 'create',
      from: '0.00',
      to: formatAmount(item.budget)
    });
  }

  // Process updated
  for (const item of runSummary.updated) {
    allocationMap.set(item.user.toLowerCase(), {
      user: item.user,
      budget: formatAmount(item.newBudget),
      status: 'updated',
      from: formatAmount(item.oldBudget),
      to: formatAmount(item.newBudget)
    });
  }

  // Process unaltered
  for (const item of runSummary.unaltered) {
    allocationMap.set(item.user.toLowerCase(), {
      user: item.user,
      budget: formatAmount(item.budget),
      status: 'unaltered',
      from: formatAmount(item.budget),
      to: formatAmount(item.budget)
    });
  }

  // 3. Construct CSV content
  const headers = ['user', 'budget', 'status', 'from', 'to'];
  let csvContent = headers.join(',') + '\n';
  
  for (const record of allocationMap.values()) {
    const row = [
      record.user,
      record.budget,
      record.status,
      record.from,
      record.to
    ];
    csvContent += row.join(',') + '\n';
  }

  try {
    fs.writeFileSync(reportPath, csvContent, 'utf8');
    console.log(`Allocation CSV saved to ${reportPath}`);
  } catch (err) {
    console.error(`Warning: Failed to write allocation CSV: ${err.message}`);
  }

  // 4. Generate detailed markdown report
  let md = `# GitHub Enterprise Billing Budgets Sync Report\n\n`;
  md += `**Execution Time:** ${runSummary.dateTime}\n\n`;
  md += `## Execution Summary\n`;
  md += `- **Created User Budgets:** ${runSummary.created.length}\n`;
  md += `- **Updated User Budgets:** ${runSummary.updated.length}\n`;
  md += `- **Unaltered User Budgets:** ${runSummary.unaltered.length}\n`;
  md += `- **Failed Operations:** ${runSummary.failed.length}\n\n`;

  md += `## Execution Details\n\n`;

  // 4.1. Created Table
  md += `### Created Budgets 🆕\n`;
  if (runSummary.created.length > 0) {
    md += `| User | Budget Amount | Status |\n`;
    md += `| :--- | :--- | :--- |\n`;
    for (const item of runSummary.created) {
      md += `| \`${item.user}\` | $${item.budget.toFixed(2)} | Success (Created) |\n`;
    }
  } else {
    md += `*No new budgets were created.*\n`;
  }
  md += `\n`;

  // 4.2. Updated Table
  md += `### Updated Budgets 🔄\n`;
  if (runSummary.updated.length > 0) {
    md += `| User | Old Budget | New Budget | Status |\n`;
    md += `| :--- | :--- | :--- | :--- |\n`;
    for (const item of runSummary.updated) {
      md += `| \`${item.user}\` | $${item.oldBudget.toFixed(2)} | $${item.newBudget.toFixed(2)} | Success (Updated) |\n`;
    }
  } else {
    md += `*No budgets were updated.*\n`;
  }
  md += `\n`;

  // 4.3. Unaltered Table
  md += `### Unaltered Budgets ✅\n`;
  if (runSummary.unaltered.length > 0) {
    md += `| User | Budget Amount | Status |\n`;
    md += `| :--- | :--- | :--- |\n`;
    for (const item of runSummary.unaltered) {
      md += `| \`${item.user}\` | $${item.budget.toFixed(2)} | Unaltered |\n`;
    }
  } else {
    md += `*No budgets were left unaltered.*\n`;
  }
  md += `\n`;

  // 4.4. Failed Table
  md += `### Failed Operations ❌\n`;
  if (runSummary.failed.length > 0) {
    md += `| User | Attempted Action | Error Message |\n`;
    md += `| :--- | :--- | :--- |\n`;
    for (const item of runSummary.failed) {
      md += `| \`${item.user}\` | **${item.action}** | \`${item.error}\` |\n`;
    }
  } else {
    md += `*No operations failed during this run.*\n`;
  }

  // Save detailed report to budget-run-report.md
  try {
    fs.writeFileSync('budget-run-report.md', md, 'utf8');
    console.log(`Markdown report saved to budget-run-report.md`);
  } catch (err) {
    console.error(`Warning: Failed to write budget-run-report.md: ${err.message}`);
  }

  // Save report to GitHub step summary if environment is present
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, 'utf8');
      console.log(`GitHub Actions step summary updated.`);
    } catch (err) {
      console.error(`Warning: Failed to write to GITHUB_STEP_SUMMARY: ${err.message}`);
    }
  }
}

/**
 * Main function orchestrating the allocation
 */
async function syncBudgets() {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${TOKEN}`,
    'X-GitHub-Api-Version': API_VERSION,
    'Content-Type': 'application/json'
  };

  try {
    if (!TOKEN || !ENTERPRISE) {
      throw new Error("Missing required environment variables: GITHUB_TOKEN or ENTERPRISE_SLUG.");
    }

    // 1. Read input CSV file
    const newBudgets = parseCSV(FILE_PATH);
    if (newBudgets.length === 0) {
      console.log("No valid user budgets found in the input spreadsheet. Exiting.");
      generateAllocationCSV();
      return;
    }

    // 2. Fetch existing user-scoped budgets from GitHub
    const existingBudgets = await fetchExistingBudgets(API_BASE_URL, headers);

    // 3. Process each record from CSV
    for (const record of newBudgets) {
      const usernameLower = record.user.toLowerCase();
      const newAmount = record.budget;

      const existingBudget = existingBudgets.get(usernameLower);

      if (existingBudget) {
        const oldAmount = existingBudget.budget_amount;
        if (oldAmount !== newAmount) {
          try {
            await updateBudget(API_BASE_URL, headers, existingBudget.id, record.user, newAmount);
            runSummary.updated.push({ user: record.user, oldBudget: oldAmount, newBudget: newAmount });
          } catch (err) {
            console.error(`[ERROR] Failed to update budget for ${record.user}:`, err.message);
            runSummary.failed.push({ user: record.user, action: 'UPDATE', error: err.message });
          }
        } else {
          console.log(`[UNALTERED] Budget for user ${record.user} is already $${newAmount.toFixed(2)}.`);
          runSummary.unaltered.push({ user: record.user, budget: newAmount });
        }
      } else {
        try {
          await createBudget(API_BASE_URL, headers, record.user, newAmount);
          runSummary.created.push({ user: record.user, budget: newAmount });
        } catch (err) {
          console.error(`[ERROR] Failed to create budget for ${record.user}:`, err.message);
          runSummary.failed.push({ user: record.user, action: 'CREATE', error: err.message });
        }
      }
    }

  } catch (error) {
    console.error("FATAL ERROR: Budget allocation failed:", error.message);
    runSummary.failed.push({ user: 'SYSTEM', action: 'INITIALIZE', error: error.message });
  } finally {
    // 4. Always build the report at the end
    generateAllocationCSV();
  }
}

// Run the script if executed directly
if (require.main === module) {
  syncBudgets().then(() => {
    if (runSummary.failed.length > 0) {
      process.exit(1);
    }
  }).catch(err => {
    console.error("Unhandled synchronization rejection:", err);
    process.exit(1);
  });
}

module.exports = {
  parseCSV,
  fetchExistingBudgets,
  createBudget,
  updateBudget,
  syncBudgets,
  runSummary,
  generateAllocationCSV,
  parseAllocationCSV
};

