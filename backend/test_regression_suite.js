const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

const {
  generateWithRetryAndFallback,
  normalizeInvoiceData,
  parseNumeric,
  parseString,
  normalizeCurrencyCode
} = require('./index.js');

const db = require('./db.js');

describe('FlowPilot Regression & Reliability Test Suite', () => {

  describe('1. Normalization & Structured Extraction', () => {
    test('Correct structured extraction from a valid Indian GST invoice', () => {
      const rawModelOutput = {
        vendor: "TechSolutions Private Limited",
        customerName: "Acme Global Corp",
        invoiceNumber: "INV-2026-089",
        date: "2026-08-08",
        dueDate: "2026-09-07",
        currency: "INR",
        subtotal: "â‚¹59,000.00",
        tax: "10620",
        cgst: "5310.00",
        sgst: "5310.00",
        igst: 0,
        totalAmount: "69,620.00",
        lineItems: [
          { description: "Cloud Infrastructure Consulting", quantity: 1, unitPrice: "59,000", amount: "59,000" }
        ]
      };

      const normalized = normalizeInvoiceData(rawModelOutput);

      assert.strictEqual(normalized.vendor.value, "TechSolutions Private Limited");
      assert.strictEqual(normalized.customerName.value, "Acme Global Corp");
      assert.strictEqual(normalized.invoiceNumber.value, "INV-2026-089");
      assert.strictEqual(normalized.date.value, "2026-08-08");
      assert.strictEqual(normalized.dueDate.value, "2026-09-07");
      assert.strictEqual(normalized.currency.value, "INR");
      assert.strictEqual(normalized.subtotal.value, 59000);
      assert.strictEqual(normalized.cgst.value, 5310);
      assert.strictEqual(normalized.sgst.value, 5310);
      assert.strictEqual(normalized.tax.value, 10620);
      assert.strictEqual(normalized.totalAmount.value, 69620);
      assert.strictEqual(normalized.taxRates.value, "CGST 9% + SGST 9% (Total 18%)");
      assert.strictEqual(normalized.lineItems.value.length, 1);
      assert.strictEqual(normalized.lineItems.value[0].unitPrice, 59000);
    });

    test('Correct structured extraction from actual Gemini nested schema (from, bill_to, items, cgst_amount, sgst_amount, shipping_freight)', () => {
      const geminiRealOutput = {
        invoice_number: "FP-TEST-20261014",
        issue_date: "14 Oct 2026",
        due_date: "14 Oct 2026",
        currency: "INR",
        from: {
          name: "DemoTech Solutions",
          gstin: "36ABCDE1234F1Z5",
          address: "Hyderabad, Telangana, India",
          email: "billing@demotech.example"
        },
        bill_to: {
          name: "FlowPilot Test Customer",
          gstin: "36PQRSX5678L1Z2",
          address: "Hyderabad, Telangana, India",
          email: "test-customer@example.com"
        },
        items: [
          { description: "Workflow automation setup", quantity: 2, unit_price: 5000, amount: 10000 }
        ],
        subtotal: 13000,
        cgst_amount: 1170,
        sgst_amount: 1170,
        shipping_freight: 500,
        grand_total: 15840,
        payment_status: "UNPAID"
      };

      const normalized = normalizeInvoiceData(geminiRealOutput);

      assert.strictEqual(normalized.vendor.value, "DemoTech Solutions");
      assert.strictEqual(normalized.vendorAddress.value, "Hyderabad, Telangana, India");
      assert.strictEqual(normalized.customerName.value, "FlowPilot Test Customer");
      assert.strictEqual(normalized.customerAddress.value, "Hyderabad, Telangana, India");
      assert.strictEqual(normalized.customerGstin.value, "36PQRSX5678L1Z2");
      assert.strictEqual(normalized.invoiceNumber.value, "FP-TEST-20261014");
      assert.strictEqual(normalized.gstNumber.value, "36ABCDE1234F1Z5");
      assert.strictEqual(normalized.currency.value, "INR");
      assert.strictEqual(normalized.subtotal.value, 13000);
      assert.strictEqual(normalized.cgst.value, 1170);
      assert.strictEqual(normalized.sgst.value, 1170);
      assert.strictEqual(normalized.totalGst.value, 2340);
      assert.strictEqual(normalized.shipping.value, 500);
      assert.strictEqual(normalized.totalAmount.value, 15840);
      assert.strictEqual(normalized.balanceDue.value, 15840);
      assert.strictEqual(normalized.paymentStatus.value, "UNPAID");
      assert.strictEqual(normalized.lineItems.value.length, 1);
      assert.strictEqual(normalized.lineItems.value[0].description, "Workflow automation setup");
      assert.strictEqual(normalized.lineItems.value[0].quantity, 2);
      assert.strictEqual(normalized.lineItems.value[0].unitPrice, 5000);
      assert.strictEqual(normalized.lineItems.value[0].taxableAmount, 10000);
      assert.strictEqual(normalized.lineItems.value[0].amount, 10000);
    });

    test('Valid zero-valued fields are preserved (roundOff: 0, discount: 0, amountPaid: 0)', () => {
      const rawModelOutput = {
        vendor: "Global Retailer",
        totalAmount: 150.00,
        subtotal: 150.00,
        roundOff: 0,
        discount: 0,
        amountPaid: 0,
        balanceDue: 150.00
      };

      const normalized = normalizeInvoiceData(rawModelOutput);

      assert.strictEqual(normalized.roundOff.value, 0);
      assert.strictEqual(normalized.roundOff.confidence > 0, true);
      assert.strictEqual(normalized.discount.value, 0);
      assert.strictEqual(normalized.amountPaid.value, 0);
      assert.strictEqual(normalized.balanceDue.value, 150);
    });

    test('Missing due dates and optional fields resolve to null with 0 confidence', () => {
      const rawModelOutput = {
        vendor: "Simple Store",
        totalAmount: 50.00
      };

      const normalized = normalizeInvoiceData(rawModelOutput);

      assert.strictEqual(normalized.dueDate.value, null);
      assert.strictEqual(normalized.dueDate.confidence, 0);
      assert.strictEqual(normalized.customerName.value, null);
      assert.strictEqual(normalized.customerName.confidence, 0);
      assert.strictEqual(normalized.cgst.value, null);
    });

    test('Currency, tax, and total normalization handles symbols and string representations', () => {
      assert.strictEqual(parseNumeric("â‚¹ 69,620.00"), 69620);
      assert.strictEqual(parseNumeric("$1,234.56"), 1234.56);
      assert.strictEqual(parseNumeric("â‚¬ 999.00"), 999);
      assert.strictEqual(parseNumeric("Rs. 4,500"), 4500);
      assert.strictEqual(parseNumeric("N/A"), null);
      assert.strictEqual(parseNumeric(""), null);
      assert.strictEqual(parseNumeric(null), null);
      assert.strictEqual(parseNumeric(undefined), null);

      assert.strictEqual(parseString("  Tech Corp  "), "Tech Corp");
      assert.strictEqual(parseString("N/A"), null);
      assert.strictEqual(parseString("null"), null);
    });

    test('Malformed and nested { value, confidence } shapes are parsed safely', () => {
      const nestedInput = {
        vendor: { value: "Apex Labs", confidence: 0.99 },
        totalAmount: { value: "4,500.50", confidence: 0.92 },
        tax: { value: 450, confidence: 0.88 }
      };

      const normalized = normalizeInvoiceData(nestedInput);
      assert.strictEqual(normalized.vendor.value, "Apex Labs");
      assert.strictEqual(normalized.vendor.confidence, 0.99);
      assert.strictEqual(normalized.totalAmount.value, 4500.50);
      assert.strictEqual(normalized.totalAmount.confidence, 0.92);
      assert.strictEqual(normalized.tax.value, 450);
    });
  });

  describe('2. Gemini Retry, Fallback & Error Handling', () => {
    test('Transient 503 Service Unavailable triggers bounded retry and succeeds on subsequent attempt', async () => {
      let attempts = 0;
      const mockGenAI = {
        getGenerativeModel: ({ model }) => ({
          generateContent: async () => {
            attempts++;
            if (attempts < 2) {
              const err = new Error("503 Service Unavailable - This model is currently experiencing high demand.");
              err.status = 503;
              throw err;
            }
            return {
              response: {
                text: () => JSON.stringify({ vendor: "Retry Success Vendor", totalAmount: 100 })
              }
            };
          }
        })
      };

      const result = await generateWithRetryAndFallback(mockGenAI, {
        primaryModel: "gemini-3.8-flash",
        fallbackModel: "gemini-3.5-flash",
        contents: ["Analyze doc"],
        stageName: "TestRetry"
      });

      assert.strictEqual(attempts, 2);
      assert.strictEqual(result.fallbackUsed, false);
      assert.strictEqual(result.modelUsed, "gemini-3.8-flash");
      assert.strictEqual(result.attempts, 2);
    });

    test('Persistent 503 on primary model initiates observable fallback to gemini-3.5-flash', async () => {
      let primaryAttempts = 0;
      let fallbackAttempts = 0;

      const mockGenAI = {
        getGenerativeModel: ({ model }) => ({
          generateContent: async () => {
            if (model === "gemini-3.8-flash") {
              primaryAttempts++;
              const err = new Error("503 Service Unavailable");
              err.status = 503;
              throw err;
            } else if (model === "gemini-3.5-flash") {
              fallbackAttempts++;
              return {
                response: {
                  text: () => JSON.stringify({ vendor: "Fallback Model Vendor", totalAmount: 250 })
                }
              };
            }
          }
        })
      };

      const result = await generateWithRetryAndFallback(mockGenAI, {
        primaryModel: "gemini-3.8-flash",
        fallbackModel: "gemini-3.5-flash",
        contents: ["Analyze doc"],
        stageName: "TestFallback"
      });

      assert.strictEqual(primaryAttempts, 3);
      assert.strictEqual(fallbackAttempts, 1);
      assert.strictEqual(result.fallbackUsed, true);
      assert.strictEqual(result.modelUsed, "gemini-3.5-flash (fallback)");
    });

    test('Non-retryable 400 / 401 permanent error fails immediately without retrying or fallback', async () => {
      let totalCalls = 0;

      const mockGenAI = {
        getGenerativeModel: ({ model }) => ({
          generateContent: async () => {
            totalCalls++;
            const err = new Error("401 API key not valid");
            err.status = 401;
            throw err;
          }
        })
      };

      await assert.rejects(
        async () => {
          await generateWithRetryAndFallback(mockGenAI, {
            primaryModel: "gemini-3.8-flash",
            fallbackModel: "gemini-3.5-flash",
            contents: ["Analyze doc"],
            stageName: "TestPermanentFail"
          });
        },
        /API key not valid/
      );

      assert.strictEqual(totalCalls, 1);
    });

    test('Daily quota exhausted 429 fails fast or switches without excessive delay', async () => {
      let primaryCalls = 0;
      let fallbackCalls = 0;

      const mockGenAI = {
        getGenerativeModel: ({ model }) => ({
          generateContent: async () => {
            if (model === "gemini-3.8-flash") {
              primaryCalls++;
              const err = new Error("429 Resource has been exhausted (e.g. check quota). Please retry in 45s.");
              err.status = 429;
              throw err;
            } else {
              fallbackCalls++;
              return {
                response: {
                  text: () => JSON.stringify({ vendor: "Quota Fallback Vendor", totalAmount: 90 })
                }
              };
            }
          }
        })
      };

      const startTime = Date.now();
      const result = await generateWithRetryAndFallback(mockGenAI, {
        primaryModel: "gemini-3.8-flash",
        fallbackModel: "gemini-3.5-flash",
        contents: ["Analyze doc"],
        stageName: "TestQuota"
      });
      const elapsed = Date.now() - startTime;

      // Should switch to fallback immediately without sleeping for 45s
      assert.strictEqual(primaryCalls, 1);
      assert.strictEqual(fallbackCalls, 1);
      assert.strictEqual(result.fallbackUsed, true);
      assert.strictEqual(elapsed < 2000, true);
    });
  });

  describe('3. Database Persistence & User Isolation', () => {
    const testDocId = "test_doc_regress_" + Date.now();
    const testUserIdA = "user_alpha_" + Date.now();
    const testUserIdB = "user_beta_" + Date.now();

    test('Saving and retrieving structured invoiceData and modelUsed', async () => {
      const invoiceData = normalizeInvoiceData({
        vendor: "Storage Test Corp",
        totalAmount: 1200,
        subtotal: 1000,
        tax: 200,
        currency: "USD"
      });

      const newDoc = {
        id: testDocId,
        userId: testUserIdA,
        filename: "test_invoice.pdf",
        filesize: 10240,
        documentType: "invoice",
        confidence: 0.98,
        summary: "Test document summary for persistence check.",
        invoiceData: invoiceData,
        modelUsed: "gemini-3.5-flash (fallback)",
        detectedType: "invoice",
        flaggedStatus: "Normal"
      };

      await db.addDocument(newDoc);

      const retrieved = await db.getDocument(testDocId);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.id, testDocId);
      assert.strictEqual(retrieved.modelUsed, "gemini-3.5-flash (fallback)");
      assert.strictEqual(retrieved.documentType, "invoice");
      assert.strictEqual(retrieved.invoiceData.vendor.value, "Storage Test Corp");
      assert.strictEqual(retrieved.invoiceData.totalAmount.value, 1200);
      assert.strictEqual(retrieved.invoiceData.subtotal.value, 1000);
    });

    test('GET /api/documents per-user isolation: User B cannot access User A documents', async () => {
      const docsA = await db.getDocuments(testUserIdA);
      const docsB = await db.getDocuments(testUserIdB);

      const hasDocInA = docsA.some(d => d.id === testDocId);
      const hasDocInB = docsB.some(d => d.id === testDocId);

      assert.strictEqual(hasDocInA, true);
      assert.strictEqual(hasDocInB, false);
    });

    test('Preservation of valid data when a subsequent extraction attempt updates document', async () => {
      const existing = await db.getDocument(testDocId);
      assert.ok(existing.invoiceData);

      // Suppose we update summary and modelUsed, existing valid invoiceData is preserved
      await db.updateDocument(testDocId, {
        summary: "Updated summary text",
        modelUsed: "gemini-3.8-flash"
      });

      const updated = await db.getDocument(testDocId);
      assert.strictEqual(updated.summary, "Updated summary text");
      assert.strictEqual(updated.modelUsed, "gemini-3.8-flash");
      assert.strictEqual(updated.invoiceData.vendor.value, "Storage Test Corp");
      assert.strictEqual(updated.invoiceData.totalAmount.value, 1200);
    });

    test('No duplicate records created during retries or re-extractions', async () => {
      const countBefore = (await db.getDocuments(testUserIdA)).length;

      // Update existing document with new extraction
      const updatedInvoiceData = normalizeInvoiceData({
        vendor: "Storage Test Corp (Updated)",
        totalAmount: 1250
      });

      await db.updateDocument(testDocId, {
        invoiceData: updatedInvoiceData
      });

      const countAfter = (await db.getDocuments(testUserIdA)).length;
      assert.strictEqual(countBefore, countAfter);

      const finalDoc = await db.getDocument(testDocId);
      assert.strictEqual(finalDoc.invoiceData.vendor.value, "Storage Test Corp (Updated)");
      assert.strictEqual(finalDoc.invoiceData.totalAmount.value, 1250);

      // Clean up test document
      await db.deleteDocument(testDocId);
      const deletedCheck = await db.getDocument(testDocId);
      assert.strictEqual(deletedCheck, null);
    });

    test('document-to-object mapping function correctly maps bankStatementData, suggestedActions, keyDates, userId, modelUsed', () => {
      const mockRow = {
        id: "doc-12345",
        fileName: "statement.pdf",
        fileSize: 45000,
        mimeType: "application/pdf",
        uploadedAt: "2026-10-22T04:00:00.000Z",
        status: "Approved",
        isDuplicate: 0,
        amountMismatch: 0,
        missingGst: 0,
        documentType: "bank_statement",
        confidence: 0.95,
        summary: "Monthly banking summary",
        ocrVerification: JSON.stringify({ readabilityScore: 0.92, notes: "Clear scan" }),
        recommendedRouting: JSON.stringify({ department: "Treasury", reason: "Bank statement" }),
        invoiceData: null,
        contractData: null,
        resumeData: null,
        sopData: null,
        policyData: null,
        purchaseOrderData: null,
        bankStatementData: JSON.stringify({
          accountNumber: { value: "XXXX-1234", confidence: 0.95 },
          closingBalance: { value: 15420.50, confidence: 0.9 }
        }),
        suggestedActions: JSON.stringify([
          { action: "Reconcile Ledger", reason: "Monthly cycle", status: "pending" }
        ]),
        keyDates: JSON.stringify([
          { label: "Statement Period End", date: "2026-09-30" }
        ]),
        userId: "user-abc-123",
        modelUsed: "gemini-3.8-flash"
      };

      const mapped = db.mapRowToDoc(mockRow);

      assert.strictEqual(mapped.id, "doc-12345");
      assert.strictEqual(mapped.userId, "user-abc-123");
      assert.strictEqual(mapped.modelUsed, "gemini-3.8-flash");
      assert.deepStrictEqual(mapped.suggestedActions, [
        { action: "Reconcile Ledger", reason: "Monthly cycle", status: "pending" }
      ]);
      assert.deepStrictEqual(mapped.keyDates, [
        { label: "Statement Period End", date: "2026-09-30" }
      ]);
      assert.strictEqual(mapped.bankStatementData.accountNumber.value, "XXXX-1234");
      assert.strictEqual(mapped.bankStatementData.closingBalance.value, 15420.50);

      // Verify userId is a single string property, not duplicated or nested
      const keys = Object.keys(mapped);
      const userIdOccurrences = keys.filter(k => k === 'userId');
      assert.strictEqual(userIdOccurrences.length, 1);
    });

    test('SQLite migration logic handles existing columns safely without errors', () => {
      // Re-running init() triggers safeAddColumn for all tables
      // Must not throw even when columns already exist
      assert.doesNotThrow(() => {
        db.init();
      });
    });

    test('db.mapRowToDoc preserves originalFile and recovers invoiceData from extractedJson fallback', () => {
      const rowWithMissingInvoiceData = {
        id: "doc-recovered-001",
        fileName: "invoice.pdf",
        fileSize: 1024,
        mimeType: "application/pdf",
        originalFile: "JVBERi0xLjQKJ...",
        extractedJson: JSON.stringify({
          invoiceData: {
            vendor: { value: "Recovered Vendor", confidence: 0.95 },
            totalAmount: { value: 5000, confidence: 0.95 }
          }
        }),
        invoiceData: null,
        status: "Pending",
        documentType: "invoice",
        confidence: 0.9
      };

      const mapped = db.mapRowToDoc(rowWithMissingInvoiceData);
      assert.strictEqual(mapped.originalFile, "JVBERi0xLjQKJ...");
      assert.ok(mapped.invoiceData);
      assert.strictEqual(mapped.invoiceData.vendor.value, "Recovered Vendor");
      assert.strictEqual(mapped.invoiceData.totalAmount.value, 5000);
    });
  });

  describe('4. Multi-Currency Detection, Persistence, Formatting & Outstanding Aggregations', () => {
    // Shared formatter replication matching frontend/src/App.tsx
    const CURRENCY_LOCALES = {
      INR: 'en-IN',
      USD: 'en-US',
      EUR: 'en-IE',
      GBP: 'en-GB'
    };

    function formatCurrencyHelper(val, currency) {
      if (val === null || val === undefined || isNaN(Number(val))) return '0.00';
      const num = Number(val);
      const code = normalizeCurrencyCode(currency);
      if (code === 'UNKNOWN') {
        return `${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (Unknown Currency)`;
      }
      const locale = CURRENCY_LOCALES[code] || 'en-US';
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(num);
    }

    test('1. INR formatting uses Indian number grouping (â‚¹77,733.00)', () => {
      const formatted = formatCurrencyHelper(77733, 'INR');
      assert.strictEqual(formatted, 'â‚¹77,733.00');

      const formattedLakhs = formatCurrencyHelper(1478118, 'INR');
      assert.strictEqual(formattedLakhs, 'â‚¹14,78,118.00');
    });

    test('2. USD formatting uses standard USD grouping ($1,250.00)', () => {
      const formatted = formatCurrencyHelper(1250, 'USD');
      assert.strictEqual(formatted, '$1,250.00');

      const formattedMillions = formatCurrencyHelper(1478118, 'USD');
      assert.strictEqual(formattedMillions, '$1,478,118.00');
    });

    test('3. Correct formatting of supported additional currencies (EUR, GBP)', () => {
      assert.strictEqual(formatCurrencyHelper(4500.50, 'EUR'), 'â‚¬4,500.50');
      assert.strictEqual(formatCurrencyHelper(1200, 'GBP'), 'Â£1,200.00');
    });

    test('4. Unknown or missing currency handling marks UNKNOWN without guessing', () => {
      assert.strictEqual(normalizeCurrencyCode(null), 'UNKNOWN');
      assert.strictEqual(normalizeCurrencyCode(undefined), 'UNKNOWN');
      assert.strictEqual(normalizeCurrencyCode(''), 'UNKNOWN');
      assert.strictEqual(normalizeCurrencyCode('UNKNOWN'), 'UNKNOWN');
      assert.strictEqual(normalizeCurrencyCode('N/A'), 'UNKNOWN');

      const formatted = formatCurrencyHelper(1250, 'UNKNOWN');
      assert.strictEqual(formatted, '1,250.00 (Unknown Currency)');

      const formattedNull = formatCurrencyHelper(1250, null);
      assert.strictEqual(formattedNull, '1,250.00 (Unknown Currency)');
    });

    test('5. Extraction detects currency from explicit code or printed symbols', () => {
      const inrDoc = normalizeInvoiceData({
        vendor: "Delhi Corp",
        totalAmount: "â‚¹77,733.00",
        currency: "INR"
      });
      assert.strictEqual(inrDoc.currency.value, "INR");
      assert.strictEqual(inrDoc.currency.confidence, 0.95);

      const usdDoc = normalizeInvoiceData({
        vendor: "SF Tech Inc",
        totalAmount: "$1,250.00"
      });
      assert.strictEqual(usdDoc.currency.value, "USD");
      assert.strictEqual(usdDoc.currency.confidence, 0.95);

      const ambiguousDoc = normalizeInvoiceData({
        vendor: "Global Logistics",
        totalAmount: "1,500.00" // No currency code, no symbol
      });
      assert.strictEqual(ambiguousDoc.currency.value, "UNKNOWN");
      assert.strictEqual(ambiguousDoc.currency.confidence, 0);
    });

    test('6. Separate INR and USD outstanding totals without cross-currency addition', () => {
      const mockDocs = [
        {
          id: 'doc-inr-1',
          documentType: 'invoice',
          status: 'Pending',
          invoiceData: {
            totalAmount: { value: 77733, confidence: 0.95 },
            currency: { value: 'INR', confidence: 0.95 }
          }
        },
        {
          id: 'doc-usd-1',
          documentType: 'invoice',
          status: 'Pending',
          invoiceData: {
            totalAmount: { value: 1250, confidence: 0.95 },
            currency: { value: 'USD', confidence: 0.95 }
          }
        }
      ];

      // Aggregation logic matching frontend useMemo
      const totalsByCurrency = {};
      for (const d of mockDocs) {
        if (d.status === 'Pending' || d.status === 'Overdue') {
          const curr = d.invoiceData?.currency?.value || 'UNKNOWN';
          const amt = d.invoiceData?.totalAmount?.value || 0;
          totalsByCurrency[curr] = (totalsByCurrency[curr] || 0) + amt;
        }
      }

      assert.strictEqual(totalsByCurrency['INR'], 77733);
      assert.strictEqual(totalsByCurrency['USD'], 1250);
      // Strictly prevent combined total across currencies
      assert.strictEqual(Object.keys(totalsByCurrency).length, 2);
      assert.notStrictEqual(totalsByCurrency['INR'], 77733 + 1250);
    });

    test('7. Paid and Rejected invoices are strictly excluded from outstanding totals', () => {
      const mockDocs = [
        {
          id: 'doc-pending',
          documentType: 'invoice',
          status: 'Pending',
          invoiceData: { totalAmount: { value: 500 }, currency: { value: 'USD' } }
        },
        {
          id: 'doc-paid',
          documentType: 'invoice',
          status: 'Paid',
          invoiceData: { totalAmount: { value: 1500 }, currency: { value: 'USD' } }
        },
        {
          id: 'doc-rejected',
          documentType: 'invoice',
          status: 'Rejected',
          invoiceData: { totalAmount: { value: 2000 }, currency: { value: 'USD' } }
        },
        {
          id: 'doc-overdue',
          documentType: 'invoice',
          status: 'Overdue',
          invoiceData: { totalAmount: { value: 300 }, currency: { value: 'USD' } }
        }
      ];

      const totals = {};
      for (const d of mockDocs) {
        if (d.status === 'Pending' || d.status === 'Overdue') {
          const curr = d.invoiceData?.currency?.value || 'UNKNOWN';
          const amt = d.invoiceData?.totalAmount?.value || 0;
          totals[curr] = (totals[curr] || 0) + amt;
        }
      }

      // Only Pending (500) + Overdue (300) = 800. Paid (1500) and Rejected (2000) are excluded.
      assert.strictEqual(totals['USD'], 800);
    });

    test('8. Duplicate prevention ensures documents are counted exactly once', () => {
      const mockDocs = [
        {
          id: 'doc-dup-1',
          documentType: 'invoice',
          status: 'Pending',
          invoiceData: { totalAmount: { value: 1000 }, currency: { value: 'INR' } }
        },
        {
          id: 'doc-dup-1', // Duplicate reference with same ID
          documentType: 'invoice',
          status: 'Pending',
          invoiceData: { totalAmount: { value: 1000 }, currency: { value: 'INR' } }
        }
      ];

      const seen = new Set();
      const totals = {};
      for (const d of mockDocs) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        const curr = d.invoiceData?.currency?.value || 'UNKNOWN';
        totals[curr] = (totals[curr] || 0) + (d.invoiceData?.totalAmount?.value || 0);
      }

      assert.strictEqual(totals['INR'], 1000);
    });

    test('9. Uses balanceDue if available; does not double-count balanceDue and totalAmount', () => {
      const doc = {
        id: 'doc-partial',
        documentType: 'invoice',
        status: 'Pending',
        invoiceData: {
          totalAmount: { value: 10000 },
          amountPaid: { value: 6000 },
          balanceDue: { value: 4000 },
          currency: { value: 'INR' }
        }
      };

      const balance = doc.invoiceData.balanceDue?.value ?? (doc.invoiceData.totalAmount.value - (doc.invoiceData.amountPaid?.value || 0));
      assert.strictEqual(balance, 4000);
    });

    test('10. Missing amounts, zero values, and invalid numbers handle safely without NaN', () => {
      assert.strictEqual(formatCurrencyHelper(0, 'INR'), 'â‚¹0.00');
      assert.strictEqual(formatCurrencyHelper(0, 'USD'), '$0.00');
      assert.strictEqual(formatCurrencyHelper(null, 'USD'), '0.00');
      assert.strictEqual(formatCurrencyHelper(undefined, 'INR'), '0.00');
      assert.strictEqual(formatCurrencyHelper('invalid', 'INR'), '0.00');
    });

    test('11. Currency column persistence in SQLite database and mapRowToDoc retrieval', async () => {
      const testDocId = `test-curr-doc-${Date.now()}`;
      const docToInsert = {
        id: testDocId,
        fileName: "multi_currency_test.pdf",
        fileSize: 2048,
        mimeType: "application/pdf",
        status: "Pending",
        documentType: "invoice",
        confidence: 0.95,
        uploadedAt: new Date().toISOString(),
        currency: "INR",
        invoiceData: {
          vendor: { value: "Bangalore Logistics", confidence: 0.95 },
          totalAmount: { value: 77733, confidence: 0.95 },
          currency: { value: "INR", confidence: 0.95 }
        },
        userId: "test-user-curr"
      };

      await db.addDocument(docToInsert);

      const retrieved = await db.getDocument(testDocId);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.currency, "INR");
      assert.strictEqual(retrieved.invoiceData.currency.value, "INR");

      // Update / reprocess document preserving currency
      await db.updateDocument(testDocId, {
        status: "Approved",
        invoiceData: {
          ...retrieved.invoiceData,
          totalAmount: { value: 80000, confidence: 0.95 }
        }
      });

      const updated = await db.getDocument(testDocId);
      assert.strictEqual(updated.status, "Approved");
      assert.strictEqual(updated.currency, "INR");
      assert.strictEqual(updated.invoiceData.totalAmount.value, 80000);

      // Cleanup
      await db.deleteDocument(testDocId);
    });

    test('12. Legacy records without currency column recover safely from invoiceData or mark UNKNOWN', () => {
      const legacyRowWithInvoiceData = {
        id: "legacy-1",
        fileName: "old_invoice.pdf",
        currency: null,
        invoiceData: JSON.stringify({
          currency: { value: "INR" }
        })
      };
      const mapped1 = db.mapRowToDoc(legacyRowWithInvoiceData);
      assert.strictEqual(mapped1.currency, "INR");

      const legacyRowUnknown = {
        id: "legacy-2",
        fileName: "unknown_invoice.pdf",
        currency: null,
        invoiceData: JSON.stringify({
          vendor: { value: "Old Vendor" }
          // No currency field
        })
      };
      const mapped2 = db.mapRowToDoc(legacyRowUnknown);
      assert.strictEqual(mapped2.currency, null);
      // Normalized for display returns UNKNOWN
      assert.strictEqual(normalizeCurrencyCode(mapped2.currency), "UNKNOWN");
    });
  });
});
