const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const assert = require('assert');

// 1. Create a test CSV file testing header variations, whitespaces, mixed casing, and errors
function createTestCSV() {
  console.log("Generating mock CSV file: test-budgets.csv");
  const content = [
    "  uSeRnAmE  ,  BuDgEt aMoUnT  ",
    "  sidd  ,150.00",                          // Trimming & Creation
    "johndoe,120.00",                                // Update (exists as johndoe: 100)
    "UnalteredUser,200.00",                          // Case-Insensitive Match (exists as unaltereduser: 200) -> Unaltered
    "invaliduser,invalid",                           // Validation failure (invalid amount)
    "   ,50.00",                                     // Empty username validation
    "erroruser,300.00",                              // Create failure (API Error)
    "patcherroruser,400.00"                          // Update failure (API Error, exists as patcherroruser: 100)
  ].join("\n");
  fs.writeFileSync('test-budgets.csv', content, 'utf8');
  console.log("Mock CSV file generated successfully.");
}

// 2. Setup mock fetch
function setupMockFetch() {
  const mockBudgets = [
    {
      id: "budget-johndoe-id",
      budget_type: "BundlePricing",
      budget_product_sku: "premium_requests",
      budget_scope: "user",
      budget_entity_name: "johndoe",
      budget_amount: 100.00,
      prevent_further_usage: true,
      budget_alerting: { will_alert: false, alert_recipients: [] }
    },
    {
      id: "budget-unaltered-id",
      budget_type: "BundlePricing",
      budget_product_sku: "premium_requests",
      budget_scope: "user",
      budget_entity_name: "unaltereduser",
      budget_amount: 200.00,
      prevent_further_usage: true,
      budget_alerting: { will_alert: false, alert_recipients: [] }
    },
    {
      id: "budget-patcherror-id",
      budget_type: "BundlePricing",
      budget_product_sku: "premium_requests",
      budget_scope: "user",
      budget_entity_name: "patcherroruser",
      budget_amount: 100.00,
      prevent_further_usage: true,
      budget_alerting: { will_alert: false, alert_recipients: [] }
    },
    {
      id: "repo-budget-id",
      budget_type: "ProductPricing",
      budget_product_sku: "actions",
      budget_scope: "repository",
      budget_entity_name: "some-repo",
      budget_amount: 50.00,
      prevent_further_usage: true,
      budget_alerting: { will_alert: false, alert_recipients: [] }
    }
  ];

  const apiCalls = {
    getCalls: 0,
    postCalls: [],
    patchCalls: []
  };

  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const parsedUrl = new URL(url);

    if (method === 'GET') {
      apiCalls.getCalls++;
      // Return existing budgets on page 1, empty arrays on subsequent pages
      const page = parsedUrl.searchParams.get('page') || '1';
      if (page === '1') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ budgets: mockBudgets }),
          text: async () => JSON.stringify({ budgets: mockBudgets })
        };
      } else {
        return {
          ok: true,
          status: 200,
          json: async () => ({ budgets: [] }),
          text: async () => JSON.stringify({ budgets: [] })
        };
      }
    }

    if (method === 'POST') {
      const body = JSON.parse(options.body);
      if (body.user === 'erroruser') {
        return {
          ok: false,
          status: 422,
          json: async () => ({ message: 'GitHub Copilot allocation failed' }),
          text: async () => 'GitHub Copilot allocation failed'
        };
      }
      apiCalls.postCalls.push({ url, body });
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: `new-budget-${body.user}`, ...body }),
        text: async () => JSON.stringify({ id: `new-budget-${body.user}`, ...body })
      };
    }

    if (method === 'PATCH') {
      const body = JSON.parse(options.body);
      if (body.user === 'patcherroruser') {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'Internal Server Error' }),
          text: async () => 'Internal Server Error'
        };
      }
      apiCalls.patchCalls.push({ url, body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...body }),
        text: async () => JSON.stringify({ ...body })
      };
    }

    return {
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
      text: async () => 'Not found'
    };
  };

  return apiCalls;
}

// 3. Run test assertions
async function runTests() {
  createTestCSV();
  
  // Set required configuration environment variables
  process.env.GITHUB_TOKEN = 'mock-token';
  process.env.ENTERPRISE_SLUG = 'mock-enterprise';
  process.env.BUDGETS_FILE_PATH = 'test-budgets.csv';
  process.env.API_VERSION = '2026-03-10';
  process.env.GITHUB_STEP_SUMMARY = 'test-step-summary.md';

  const apiCalls = setupMockFetch();

  // Require the synchronizer module
  const manageBudgets = require('./manage-budgets.js');
  
  console.log("Executing budget synchronization logic...");
  
  await manageBudgets.syncBudgets();
  
  console.log("\nSync process completed. Verifying results...");

  // Verify internal state summary
  console.log("Checking run summary totals:");
  console.log(`Created: ${manageBudgets.runSummary.created.length} (Expected: 1)`);
  console.log(`Updated: ${manageBudgets.runSummary.updated.length} (Expected: 1)`);
  console.log(`Unaltered: ${manageBudgets.runSummary.unaltered.length} (Expected: 1)`);
  console.log(`Failed: ${manageBudgets.runSummary.failed.length} (Expected: 2)`);

  // Assertion for sidd (created, trimming test)
  assert.strictEqual(manageBudgets.runSummary.created.length, 1, "Should have created exactly 1 budget");
  assert.strictEqual(manageBudgets.runSummary.created[0].user, "sidd");
  assert.strictEqual(manageBudgets.runSummary.created[0].budget, 150.00);

  // Assertion for johndoe (updated)
  assert.strictEqual(manageBudgets.runSummary.updated.length, 1, "Should have updated exactly 1 budget");
  assert.strictEqual(manageBudgets.runSummary.updated[0].user, "johndoe");
  assert.strictEqual(manageBudgets.runSummary.updated[0].oldBudget, 100.00);
  assert.strictEqual(manageBudgets.runSummary.updated[0].newBudget, 120.00);

  // Assertion for UnalteredUser (unaltered, case-insensitive mapping test)
  assert.strictEqual(manageBudgets.runSummary.unaltered.length, 1, "Should have left exactly 1 budget unaltered");
  assert.strictEqual(manageBudgets.runSummary.unaltered[0].user, "UnalteredUser");
  assert.strictEqual(manageBudgets.runSummary.unaltered[0].budget, 200.00);

  // Assertion for failures (erroruser - CREATE error, patcherroruser - UPDATE error)
  assert.strictEqual(manageBudgets.runSummary.failed.length, 2, "Should have exactly 2 failed operations");
  
  const fail1 = manageBudgets.runSummary.failed.find(f => f.user === 'erroruser');
  assert.ok(fail1, "erroruser should have failed");
  assert.strictEqual(fail1.action, 'CREATE');
  assert.ok(fail1.error.includes('HTTP 422'), "Error should mention HTTP 422");

  const fail2 = manageBudgets.runSummary.failed.find(f => f.user === 'patcherroruser');
  assert.ok(fail2, "patcherroruser should have failed");
  assert.strictEqual(fail2.action, 'UPDATE');
  assert.ok(fail2.error.includes('HTTP 500'), "Error should mention HTTP 500");

  // Verify that report files were written
  assert.ok(fs.existsSync('allocation.csv'), "Report file allocation.csv must exist");
  assert.ok(fs.existsSync('budget-run-report.md'), "Report file budget-run-report.md must exist");
  assert.ok(fs.existsSync('test-step-summary.md'), "Step summary file test-step-summary.md must exist");

  const csvContent = fs.readFileSync('allocation.csv', 'utf8');
  console.log("\nGenerated CSV Content Preview:\n======================================");
  console.log(csvContent);
  console.log("======================================\n");

  // Assert CSV content verification
  const csvLines = csvContent.trim().split('\n');
  assert.strictEqual(csvLines[0], 'user,budget,status,from,to', "CSV headers must be user,budget,status,from,to");
  assert.ok(csvLines.includes('sidd,150.00,create,0.00,150.00'), "CSV should contain created user sidd");
  assert.ok(csvLines.includes('johndoe,120.00,updated,100.00,120.00'), "CSV should contain updated user johndoe");
  assert.ok(csvLines.includes('UnalteredUser,200.00,unaltered,200.00,200.00'), "CSV should contain unaltered user UnalteredUser");

  // Test incremental update of allocation.csv
  console.log("Testing incremental updates of allocation.csv...");
  // Modify the runSummary to simulate a second run
  manageBudgets.runSummary.created = [{ user: "newuser", budget: 75.00 }];
  manageBudgets.runSummary.updated = [{ user: "sidd", oldBudget: 150.00, newBudget: 180.00 }];
  manageBudgets.runSummary.unaltered = []; // johndoe and UnalteredUser should remain from previous file but status will not change unless they run again

  // Run generation again
  manageBudgets.generateAllocationCSV();

  const updatedCsvContent = fs.readFileSync('allocation.csv', 'utf8');
  console.log("\nUpdated CSV Content Preview:\n======================================");
  console.log(updatedCsvContent);
  console.log("======================================\n");

  const updatedCsvLines = updatedCsvContent.trim().split('\n');
  assert.strictEqual(updatedCsvLines[0], 'user,budget,status,from,to');
  
  // New user should be added
  assert.ok(updatedCsvLines.includes('newuser,75.00,create,0.00,75.00'), "CSV should contain newly created user");
  // Sidd should be updated
  assert.ok(updatedCsvLines.includes('sidd,180.00,updated,150.00,180.00'), "CSV should contain updated sidd");
  // johndoe and UnalteredUser should still exist with their previous values
  assert.ok(updatedCsvLines.includes('johndoe,120.00,updated,100.00,120.00'), "CSV should still contain johndoe");
  assert.ok(updatedCsvLines.includes('UnalteredUser,200.00,unaltered,200.00,200.00'), "CSV should still contain UnalteredUser");

  // Clean up files
  console.log("Cleaning up generated test files...");
  fs.unlinkSync('test-budgets.csv');
  fs.unlinkSync('allocation.csv');
  fs.unlinkSync('budget-run-report.md');
  fs.unlinkSync('test-step-summary.md');

  console.log("Cleanup completed.");
  console.log("\nSUCCESS: All advanced scenario budget allocation validation tests passed!");
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
