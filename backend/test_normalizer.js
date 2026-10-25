const assert = require('node:assert');

function parseNumeric(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return isNaN(val) ? null : val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '' || /^n\/?a$/i.test(trimmed) || /^null$/i.test(trimmed)) return null;
    const cleaned = trimmed.replace(/[₹$€£,\s]|INR|USD|EUR|GBP|Rs\.?/gi, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }
  return null;
}

function parseString(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return null;
  const str = String(val).trim();
  if (str === '' || /^n\/?a$/i.test(str) || /^null$/i.test(str) || /^undefined$/i.test(str)) return null;
  return str;
}

function getRaw(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null) {
      return obj[k];
    }
  }
  return undefined;
}

function normalizeField(rawVal, type = 'string', defaultConfidence = 0.95) {
  let val = rawVal;
  let conf = defaultConfidence;

  if (rawVal !== null && typeof rawVal === 'object' && !Array.isArray(rawVal) && ('value' in rawVal || 'confidence' in rawVal)) {
    val = rawVal.value;
    if (typeof rawVal.confidence === 'number') {
      conf = rawVal.confidence;
    }
  }

  if (type === 'number') {
    const parsed = parseNumeric(val);
    return {
      value: parsed,
      confidence: parsed !== null ? conf : 0
    };
  } else if (type === 'string') {
    const parsed = parseString(val);
    return {
      value: parsed,
      confidence: parsed !== null ? conf : 0
    };
  }

  return { value: val ?? null, confidence: conf };
}

function normalizeInvoiceData(rawInvoiceData, rawAnalysis = {}) {
  const source = rawInvoiceData || rawAnalysis.invoiceData || rawAnalysis;

  const vendor = normalizeField(getRaw(source, ['vendor', 'vendor_name', 'supplier', 'seller', 'bill_from', 'billed_by']), 'string');
  const customerName = normalizeField(getRaw(source, ['customerName', 'customer_name', 'customer', 'client', 'bill_to', 'billed_to', 'buyer']), 'string');
  const invoiceNumber = normalizeField(getRaw(source, ['invoiceNumber', 'invoice_number', 'invoice_no', 'bill_no', 'tax_invoice_no']), 'string');
  const date = normalizeField(getRaw(source, ['date', 'invoice_date', 'bill_date', 'billing_date', 'issue_date']), 'string');
  const dueDate = normalizeField(getRaw(source, ['dueDate', 'due_date', 'payment_due', 'pay_by']), 'string');

  const subtotal = normalizeField(getRaw(source, ['subtotal', 'sub_total', 'taxable_subtotal', 'taxable_amount', 'net_amount']), 'number');
  const grossSubtotal = normalizeField(getRaw(source, ['grossSubtotal', 'gross_subtotal', 'gross_amount']), 'number');
  const netTaxableSubtotal = normalizeField(getRaw(source, ['netTaxableSubtotal', 'net_taxable_subtotal', 'taxable_value']), 'number');

  const tax = normalizeField(getRaw(source, ['tax', 'tax_amount', 'total_tax', 'taxes']), 'number');
  const cgst = normalizeField(getRaw(source, ['cgst', 'cgst_amount', 'central_tax', 'central_gst']), 'number');
  const sgst = normalizeField(getRaw(source, ['sgst', 'sgst_amount', 'state_tax', 'state_gst']), 'number');
  const igst = normalizeField(getRaw(source, ['igst', 'igst_amount', 'integrated_tax', 'integrated_gst']), 'number');
  const vat = normalizeField(getRaw(source, ['vat', 'vat_amount']), 'number');
  const salesTax = normalizeField(getRaw(source, ['salesTax', 'sales_tax']), 'number');
  const otherTaxes = normalizeField(getRaw(source, ['otherTaxes', 'other_taxes']), 'number');
  const roundOff = normalizeField(getRaw(source, ['roundOff', 'round_off', 'roundoff']), 'number');

  const discount = normalizeField(getRaw(source, ['discount', 'discount_amount']), 'number');
  const shipping = normalizeField(getRaw(source, ['shipping', 'shipping_amount']), 'number');
  const freight = normalizeField(getRaw(source, ['freight', 'freight_charges']), 'number');
  const otherCharges = normalizeField(getRaw(source, ['otherCharges', 'other_charges']), 'number');

  const totalAmount = normalizeField(getRaw(source, ['totalAmount', 'total_amount', 'total', 'invoice_total', 'grand_total', 'amount_due', 'net_payable']), 'number');
  const amountPaid = normalizeField(getRaw(source, ['amountPaid', 'amount_paid', 'paid_amount']), 'number');
  const balanceDue = normalizeField(getRaw(source, ['balanceDue', 'balance_due', 'balance', 'outstanding_balance']), 'number');
  const paymentStatus = normalizeField(getRaw(source, ['paymentStatus', 'payment_status', 'status']), 'string');

  let currencyVal = parseString(getRaw(source, ['currency', 'currency_code', 'symbol']));
  if (!currencyVal) {
    if (source.totalAmount && typeof source.totalAmount === 'string' && source.totalAmount.includes('₹')) currencyVal = 'INR';
    else if (source.totalAmount && typeof source.totalAmount === 'string' && source.totalAmount.includes('$')) currencyVal = 'USD';
    else if (cgst.value !== null || sgst.value !== null || igst.value !== null) currencyVal = 'INR';
    else currencyVal = 'USD';
  }
  const currency = { value: currencyVal, confidence: 0.95 };

  let taxRatesVal = parseString(getRaw(source, ['taxRates', 'tax_rates', 'tax_rate', 'gst_rate']));
  if (!taxRatesVal) {
    const base = netTaxableSubtotal.value || subtotal.value;
    if (base && base > 0) {
      if (cgst.value && sgst.value && cgst.value > 0 && sgst.value > 0) {
        const cRate = Math.round((cgst.value / base) * 100);
        const sRate = Math.round((sgst.value / base) * 100);
        taxRatesVal = `CGST ${cRate}% + SGST ${sRate}% (Total ${cRate + sRate}%)`;
      } else if (igst.value && igst.value > 0) {
        const iRate = Math.round((igst.value / base) * 100);
        taxRatesVal = `IGST ${iRate}%`;
      } else if (tax.value && tax.value > 0) {
        const tRate = Math.round((tax.value / base) * 100);
        taxRatesVal = `Tax ${tRate}%`;
      }
    }
  }
  const taxRates = { value: taxRatesVal, confidence: taxRatesVal ? 0.9 : 0 };

  const gstNumber = normalizeField(getRaw(source, ['gstNumber', 'gst_number', 'gstin', 'tax_id', 'vat_number']), 'string');
  const paymentTerms = normalizeField(getRaw(source, ['paymentTerms', 'payment_terms', 'terms']), 'string');
  const email = normalizeField(getRaw(source, ['email', 'vendor_email', 'contact_email']), 'string');
  const phone = normalizeField(getRaw(source, ['phone', 'vendor_phone', 'contact_phone']), 'string');
  const poNumber = normalizeField(getRaw(source, ['poNumber', 'po_number', 'purchase_order']), 'string');
  const hsnSac = normalizeField(getRaw(source, ['hsnSac', 'hsn_sac', 'hsn', 'sac']), 'string');

  const rawItems = getRaw(source, ['lineItems', 'line_items', 'items']) || [];
  let itemsList = Array.isArray(rawItems) ? rawItems : (rawItems.value && Array.isArray(rawItems.value) ? rawItems.value : []);
  const lineItems = {
    value: itemsList.map(item => ({
      description: parseString(item.description) || "Item",
      quantity: parseNumeric(item.quantity),
      unitPrice: parseNumeric(item.unitPrice || item.unit_price || item.rate),
      amount: parseNumeric(item.amount || item.total || item.lineTotal || item.line_total)
    })),
    confidence: itemsList.length > 0 ? 0.95 : 0
  };

  return {
    vendor,
    customerName,
    invoiceNumber,
    date,
    dueDate,
    subtotal,
    grossSubtotal,
    netTaxableSubtotal,
    tax,
    cgst,
    sgst,
    igst,
    vat,
    salesTax,
    otherTaxes,
    taxRates,
    discount,
    shipping,
    freight,
    otherCharges,
    roundOff,
    totalAmount,
    amountPaid,
    balanceDue,
    paymentStatus,
    currency,
    gstNumber,
    paymentTerms,
    email,
    phone,
    poNumber,
    hsnSac,
    lineItems
  };
}

// Tests
console.log("Testing normalizeInvoiceData with nested {value, confidence}...");
const nestedInput = {
  vendor: { value: "TechNova", confidence: 0.98 },
  totalAmount: { value: 69620, confidence: 0.98 },
  subtotal: { value: 59000, confidence: 0.98 },
  cgst: { value: 5310, confidence: 0.98 },
  sgst: { value: 5310, confidence: 0.98 },
  roundOff: { value: 0, confidence: 0.98 }
};
const res1 = normalizeInvoiceData(nestedInput);
assert.strictEqual(res1.vendor.value, "TechNova");
assert.strictEqual(res1.totalAmount.value, 69620);
assert.strictEqual(res1.cgst.value, 5310);
assert.strictEqual(res1.sgst.value, 5310);
assert.strictEqual(res1.roundOff.value, 0, "Valid zero roundOff must be preserved");
assert.strictEqual(res1.taxRates.value, "CGST 9% + SGST 9% (Total 18%)", "Tax rate derived contextually");
console.log("Test 1 passed!");

console.log("Testing normalizeInvoiceData with flat string/primitive inputs...");
const flatInput = {
  vendor: "Apex Cloud LLC",
  total_amount: "₹69,620.00",
  subtotal: "59,000",
  cgst: "5,310.00",
  sgst: "5,310.00",
  round_off: 0,
  due_date: "September 7, 2026",
  gstin: "36AABCT8472K1Z5",
  items: [
    { description: "Hosting", quantity: "1", unit_price: "48000", amount: "48000" }
  ]
};
const res2 = normalizeInvoiceData(flatInput);
assert.strictEqual(res2.vendor.value, "Apex Cloud LLC");
assert.strictEqual(res2.totalAmount.value, 69620);
assert.strictEqual(res2.subtotal.value, 59000);
assert.strictEqual(res2.cgst.value, 5310);
assert.strictEqual(res2.sgst.value, 5310);
assert.strictEqual(res2.roundOff.value, 0);
assert.strictEqual(res2.dueDate.value, "September 7, 2026");
assert.strictEqual(res2.gstNumber.value, "36AABCT8472K1Z5");
assert.strictEqual(res2.lineItems.value.length, 1);
assert.strictEqual(res2.lineItems.value[0].unitPrice, 48000);
assert.strictEqual(res2.currency.value, "INR");
console.log("Test 2 passed!");

console.log("All normalizer tests passed!");
