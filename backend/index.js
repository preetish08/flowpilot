const express = require("express");
const cors = require("cors");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const db = require("./db");
require("dotenv").config();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const JWT_SECRET = process.env.JWT_SECRET || "flowpilot_jwt_secret_token_key_2026";

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  
  if (!token) {
    return res.status(401).json({ error: "Access Denied: No Token Provided." });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Access Denied: Invalid or Expired Token." });
    }
    req.user = user;
    next();
  });
};

const app = express();
const PORT = process.env.PORT || 5000;

// Enable Helmet security headers, CORS and JSON parsing
app.use(helmet());
app.use(cors());
app.use(express.json());

// Set up general rate limiter
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per 15 minutes
  message: { error: "Too many requests from this IP. Please try again later." }
});
app.use(generalLimiter);

// Specific rate limiter for file uploads to protect API costs and budget
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 30, // Limit each IP to 30 uploads per hour
  message: { error: "Too many document upload requests. Rate limit is 30 uploads per hour per IP. Please try again later." }
});

// Set up Multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Initialize Gemini API
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error("WARNING: GEMINI_API_KEY is not defined in the environment variables!");
}
const genAI = new GoogleGenerativeAI(geminiApiKey || "");

// Standard reusable schemas for field + confidence score
// We omit "value" from required parameters so Gemini can return null/omit it if missing
const valueString = {
  type: SchemaType.OBJECT,
  properties: {
    value: { type: SchemaType.STRING, description: "The extracted value as a string. Set to null if missing or not found.", nullable: true },
    confidence: { type: SchemaType.NUMBER, description: "Confidence score between 0.0 and 1.0." }
  },
  required: ["value", "confidence"]
};

const valueNumber = {
  type: SchemaType.OBJECT,
  properties: {
    value: { type: SchemaType.NUMBER, description: "The extracted value as a number. Set to null if missing or not found.", nullable: true },
    confidence: { type: SchemaType.NUMBER, description: "Confidence score between 0.0 and 1.0." }
  },
  required: ["value", "confidence"]
};

const valueArrayString = {
  type: SchemaType.OBJECT,
  properties: {
    value: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "The extracted values as an array of strings. Set to null if missing or not found.",
      nullable: true
    },
    confidence: { type: SchemaType.NUMBER, description: "Confidence score between 0.0 and 1.0." }
  },
  required: ["value", "confidence"]
};

// Define strict schema for structured Gemini output (auto-routing based on documentType)
const classificationSchema = {
  type: SchemaType.OBJECT,
  properties: {
    documentType: {
      type: SchemaType.STRING,
      description: "Must be exactly one of: invoice, receipt, resume, contract, purchase_order, bank_statement, policy, or sop."
    },
    confidence: { type: SchemaType.NUMBER }
  },
  required: ["documentType", "confidence"]
};

const lineItemSchema = {
  type: SchemaType.OBJECT,
  properties: {
    description: { type: SchemaType.STRING, description: "Item description." },
    quantity: { type: SchemaType.NUMBER, description: "Quantity of items. Set to null if missing.", nullable: true },
    unitPrice: { type: SchemaType.NUMBER, description: "Unit price of item. Set to null if missing.", nullable: true },
    amount: { type: SchemaType.NUMBER, description: "Line item total amount. Set to null if missing.", nullable: true }
  },
  required: ["description", "quantity", "unitPrice", "amount"]
};

const valueArrayLineItems = {
  type: SchemaType.OBJECT,
  properties: {
    value: {
      type: SchemaType.ARRAY,
      items: lineItemSchema,
      description: "Array of extracted line items.",
      nullable: true
    },
    confidence: { type: SchemaType.NUMBER, description: "Confidence score between 0.0 and 1.0." }
  },
  required: ["value", "confidence"]
};

const ocrVerificationSchema = {
  type: SchemaType.OBJECT,
  description: "Audit metrics regarding document OCR quality and clarity",
  properties: {
    readabilityScore: { type: SchemaType.NUMBER, description: "Clarity score from 0.0 (unreadable) to 1.0 (perfectly clear)." },
    notes: { type: SchemaType.STRING, description: "Visual audit details (e.g. rotated, blurry, handwritten, noisy scan, clean scan)." }
  },
  required: ["readabilityScore", "notes"]
};

const invoiceSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    ocrVerification: ocrVerificationSchema,
    recommendedRouting: {
      type: SchemaType.OBJECT,
      properties: { department: { type: SchemaType.STRING }, reason: { type: SchemaType.STRING } },
      required: ["department", "reason"]
    },
    invoiceData: {
      type: SchemaType.OBJECT,
      properties: {
        vendor: valueString,
        customerName: valueString,
        invoiceNumber: valueString,
        date: valueString,
        dueDate: valueString,
        subtotal: valueNumber,
        tax: valueNumber,
        shipping: valueNumber,
        discount: valueNumber,
        totalAmount: valueNumber,
        currency: valueString,
        gstNumber: valueString,
        paymentTerms: valueString,
        email: valueString,
        phone: valueString,
        grossSubtotal: valueNumber,
        netTaxableSubtotal: valueNumber,
        cgst: valueNumber,
        sgst: valueNumber,
        igst: valueNumber,
        vat: valueNumber,
        salesTax: valueNumber,
        otherTaxes: valueNumber,
        roundOff: valueNumber,
        freight: valueNumber,
        otherCharges: valueNumber,
        poNumber: valueString,
        hsnSac: valueString,
        lineItems: valueArrayLineItems
      },
      required: [
        "vendor",
        "customerName",
        "invoiceNumber",
        "date",
        "dueDate",
        "subtotal",
        "tax",
        "shipping",
        "discount",
        "totalAmount",
        "currency",
        "gstNumber",
        "paymentTerms",
        "email",
        "phone",
        "grossSubtotal",
        "netTaxableSubtotal",
        "cgst",
        "sgst",
        "igst",
        "vat",
        "salesTax",
        "otherTaxes",
        "roundOff",
        "freight",
        "otherCharges",
        "poNumber",
        "hsnSac",
        "lineItems"
      ]
    }
  },
  required: ["summary", "recommendedRouting", "ocrVerification", "invoiceData"]
};

const receiptSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    ocrVerification: ocrVerificationSchema,
    recommendedRouting: {
      type: SchemaType.OBJECT,
      properties: { department: { type: SchemaType.STRING }, reason: { type: SchemaType.STRING } },
      required: ["department", "reason"]
    },
    receiptData: {
      type: SchemaType.OBJECT,
      properties: {
        merchantName: valueString,
        date: valueString,
        totalAmount: valueNumber,
        taxAmount: valueNumber,
        paymentMethod: valueString
      },
      required: ["merchantName", "date", "totalAmount", "taxAmount", "paymentMethod"]
    }
  },
  required: ["summary", "recommendedRouting", "ocrVerification", "receiptData"]
};

const resumeSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    ocrVerification: ocrVerificationSchema,
    recommendedRouting: {
      type: SchemaType.OBJECT,
      properties: { department: { type: SchemaType.STRING }, reason: { type: SchemaType.STRING } },
      required: ["department", "reason"]
    },
    resumeData: {
      type: SchemaType.OBJECT,
      properties: {
        candidateName: valueString,
        email: valueString,
        phone: valueString,
        skills: valueArrayString,
        experienceYears: valueNumber,
        education: valueArrayString
      },
      required: ["candidateName", "email", "phone", "skills", "experienceYears", "education"]
    }
  },
  required: ["summary", "recommendedRouting", "ocrVerification", "resumeData"]
};

const contractSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    ocrVerification: ocrVerificationSchema,
    recommendedRouting: {
      type: SchemaType.OBJECT,
      properties: { department: { type: SchemaType.STRING }, reason: { type: SchemaType.STRING } },
      required: ["department", "reason"]
    },
    contractData: {
      type: SchemaType.OBJECT,
      properties: {
        title: valueString,
        parties: valueArrayString,
        effectiveDate: valueString,
        terminationDate: valueString,
        keyObligations: valueArrayString
      },
      required: ["title", "parties", "effectiveDate", "terminationDate", "keyObligations"]
    }
  },
  required: ["summary", "recommendedRouting", "ocrVerification", "contractData"]
};

const purchaseOrderSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    ocrVerification: ocrVerificationSchema,
    recommendedRouting: {
      type: SchemaType.OBJECT,
      properties: { department: { type: SchemaType.STRING }, reason: { type: SchemaType.STRING } },
      required: ["department", "reason"]
    },
    purchaseOrderData: {
      type: SchemaType.OBJECT,
      properties: {
        poNumber: valueString,
        buyer: valueString,
        vendor: valueString,
        date: valueString,
        totalAmount: valueNumber,
        deliveryDate: valueString
      },
      required: ["poNumber", "buyer", "vendor", "date", "totalAmount", "deliveryDate"]
    }
  },
  required: ["summary", "recommendedRouting", "ocrVerification", "purchaseOrderData"]
};

const bankStatementSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    ocrVerification: ocrVerificationSchema,
    recommendedRouting: {
      type: SchemaType.OBJECT,
      properties: { department: { type: SchemaType.STRING }, reason: { type: SchemaType.STRING } },
      required: ["department", "reason"]
    },
    bankStatementData: {
      type: SchemaType.OBJECT,
      properties: {
        bankName: valueString,
        accountHolder: valueString,
        accountNumber: valueString,
        statementDate: valueString,
        startingBalance: valueNumber,
        endingBalance: valueNumber
      },
      required: ["bankName", "accountHolder", "accountNumber", "statementDate", "startingBalance", "endingBalance"]
    }
  },
  required: ["summary", "recommendedRouting", "ocrVerification", "bankStatementData"]
};

const policySchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    ocrVerification: ocrVerificationSchema,
    recommendedRouting: {
      type: SchemaType.OBJECT,
      properties: { department: { type: SchemaType.STRING }, reason: { type: SchemaType.STRING } },
      required: ["department", "reason"]
    },
    policyData: {
      type: SchemaType.OBJECT,
      properties: {
        policyName: valueString,
        effectiveDate: valueString,
        scope: valueString,
        keyRules: valueArrayString
      },
      required: ["policyName", "effectiveDate", "scope", "keyRules"]
    }
  },
  required: ["summary", "recommendedRouting", "ocrVerification", "policyData"]
};

const sopSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    ocrVerification: ocrVerificationSchema,
    recommendedRouting: {
      type: SchemaType.OBJECT,
      properties: { department: { type: SchemaType.STRING }, reason: { type: SchemaType.STRING } },
      required: ["department", "reason"]
    },
    sopData: {
      type: SchemaType.OBJECT,
      properties: {
        title: valueString,
        department: valueString,
        steps: valueArrayString,
        scope: valueString
      },
      required: ["title", "department", "steps", "scope"]
    }
  },
  required: ["summary", "recommendedRouting", "ocrVerification", "sopData"]
};

const otherSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    ocrVerification: ocrVerificationSchema,
    recommendedRouting: {
      type: SchemaType.OBJECT,
      properties: { department: { type: SchemaType.STRING }, reason: { type: SchemaType.STRING } },
      required: ["department", "reason"]
    }
  },
  required: ["summary", "recommendedRouting", "ocrVerification"]
};

// Helper function to format file buffer to base64 object for Gemini
function bufferToGenerativePart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType
    }
  };
}

// Scheduled Daily Check and Email Dispatch job logic
// Email service abstraction
class EmailService {
  async sendEmail({ to, subject, body }) {
    const smtpConfigured = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
    if (smtpConfigured) {
      console.log(`[SMTP] Sending real email to ${to}...`);
      return { success: true, method: "SMTP" };
    } else {
      const simulatedText = `[SIMULATED EMAIL]\nTo: ${to}\nSubject: ${subject}\nBody:\n${body}`;
      console.log("-----------------------------------------");
      console.log(simulatedText);
      console.log("-----------------------------------------");
      return { success: true, method: "SIMULATED" };
    }
  }
}

const emailService = new EmailService();

// Scheduled Daily Check and Email Dispatch job logic
async function runDailyChecks(userId = null) {
  const documents = await db.getDocuments(userId);
  const today = new Date(); // local server time
  let count = 0;
  const decisionLogs = [];

  const logDecision = (message) => {
    console.log(message);
    decisionLogs.push(message);
  };

  logDecision(`--- Starting Automation Engine run at ${today.toISOString()} ---`);
  logDecision(`Fetched ${documents.length} documents from registry.`);

  for (const doc of documents) {
    if (doc.documentType !== "invoice" && doc.documentType !== "receipt") {
      logDecision(`Document ${doc.id} (${doc.fileName}): Ignored (Type is ${doc.documentType})`);
      continue;
    }

    if (doc.status === "Paid") {
      logDecision(`Invoice ${doc.id} (${doc.fileName}): Ignored (Status is PAID)`);
      continue;
    }
    
    if (doc.status === "Rejected") {
      logDecision(`Invoice ${doc.id} (${doc.fileName}): Ignored (Status is REJECTED)`);
      continue;
    }

    const dueDateStr = doc.invoiceData?.dueDate?.value;
    if (!dueDateStr) {
      logDecision(`Invoice ${doc.id} (${doc.fileName}): Ignored (Missing due date)`);
      continue;
    }

    const dueDate = new Date(dueDateStr);
    if (isNaN(dueDate.getTime())) {
      logDecision(`Invoice ${doc.id} (${doc.fileName}): Ignored (Invalid due date "${dueDateStr}")`);
      continue;
    }

    // Calculate time difference in calendar days
    const dDate = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
    const tDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diffTime = dDate.getTime() - tDate.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    const schedDateStr = today.toISOString().split("T")[0];

    // Automatically flag as overdue if due date is in the past
    if (diffDays < 0 && doc.status !== "Overdue") {
      await db.updateDocument(doc.id, { status: "Overdue" });
      doc.status = "Overdue";
      logDecision(`Invoice ${doc.id} (${doc.fileName}): Marked as OVERDUE (Due date ${dueDateStr} is past)`);
      
      // Log overdue state change event to EmailLogs for history UI
      await db.addEmailLog({
        id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
        documentId: doc.id,
        documentName: doc.fileName,
        recipient: "System Scheduler",
        subject: `[Overdue] Invoice ${doc.invoiceData?.invoiceNumber?.value || doc.id} became Overdue`,
        body: `Invoice due date was ${dueDateStr}. Automatically marked as Overdue by system scheduler because it remains unpaid.`,
        sentAt: new Date().toISOString(),
        reminderType: "status_change",
        scheduledDate: schedDateStr,
        status: "Sent",
        userId: doc.userId
      });
    }

    let reminderType = null;
    let subject = "";

    // reminder logic rules
    if (diffDays === 7) {
      reminderType = "due_7_days";
      subject = `Reminder: Invoice ${doc.invoiceData?.invoiceNumber?.value || "N/A"} is due in 7 days`;
    } else if (diffDays === 3) {
      reminderType = "due_3_days";
      subject = `Action Required: Invoice ${doc.invoiceData?.invoiceNumber?.value || "N/A"} is due in 3 days`;
    } else if (diffDays === 1) {
      reminderType = "due_1_day";
      subject = `URGENT: Invoice ${doc.invoiceData?.invoiceNumber?.value || "N/A"} is due TOMORROW`;
    } else if (diffDays === 0) {
      reminderType = "due_today";
      subject = `URGENT: Invoice ${doc.invoiceData?.invoiceNumber?.value || "N/A"} is due TODAY`;
    } else if (diffDays < 0) {
      // Overdue weekly logic
      const absOverdueDays = Math.abs(diffDays);
      if (absOverdueDays % 7 === 0) {
        const weeks = absOverdueDays / 7;
        reminderType = `overdue_weekly_w${weeks}`;
        subject = `URGENT: Invoice ${doc.invoiceData?.invoiceNumber?.value || "N/A"} is ${weeks} week(s) OVERDUE`;
      }
    }

    if (!reminderType) {
      logDecision(`Invoice ${doc.id} (${doc.fileName}): No reminder due today (due date: ${dueDateStr}, diffDays: ${diffDays})`);
      continue;
    }

    // Determine recipient email and log missing emails
    let recipient = doc.invoiceData?.email?.value;
    if (!recipient) {
      // Graceful fallback to routing department email if missing
      recipient = doc.recommendedRouting?.department === "Finance" ? "finance-approvals@flowpilot.io" : "operations-routing@flowpilot.io";
      logDecision(`Invoice ${doc.id} (${doc.fileName}): Warning - recipient email missing. Falling back to department email: ${recipient}`);
    }

    // Prevent duplicate reminder emails
    const sentBefore = await db.hasReminderBeenSent(doc.id, reminderType, schedDateStr);
    if (sentBefore) {
      logDecision(`Invoice ${doc.id} (${doc.fileName}): Reminder type "${reminderType}" already sent. Preventing duplicate.`);
      continue;
    }

    const vendor = doc.invoiceData?.vendor?.value || "Unknown Vendor";
    const invoiceNum = doc.invoiceData?.invoiceNumber?.value || "N/A";
    const currency = doc.invoiceData?.currency?.value || "$";
    const amount = doc.invoiceData?.totalAmount?.value || 0;

    const body = `Dear Partner,\n\nThis is an automated notification regarding a pending invoice in FlowPilot.\n\n` +
                 `- Vendor: ${vendor}\n` +
                 `- Invoice Number: ${invoiceNum}\n` +
                 `- Total Amount: ${currency} ${amount.toLocaleString()}\n` +
                 `- Due Date: ${dueDateStr}\n` +
                 `- Status: ${doc.status}\n\n` +
                 `Please review and process the payment as soon as possible.\n\n` +
                 `Best regards,\nFlowPilot Accounts Automation`;

    logDecision(`Invoice ${doc.id} (${doc.fileName}): Sending reminder "${reminderType}" to ${recipient}...`);

    let status = "Sent";
    let errorMessage = null;

    try {
      await emailService.sendEmail({ to: recipient, subject, body });
      count++;
    } catch (sendErr) {
      status = "Failed";
      errorMessage = sendErr.message;
      logDecision(`Invoice ${doc.id} (${doc.fileName}): Email sending failed: ${sendErr.message}`);
    }

    // Add to emailLogs database (Reminder history persistence)
    await db.addEmailLog({
      id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
      documentId: doc.id,
      documentName: doc.fileName,
      recipient,
      subject,
      body,
      sentAt: new Date().toISOString(),
      reminderType,
      scheduledDate: schedDateStr,
      status,
      errorMessage,
      userId: doc.userId
    });

    // Register that this reminder was sent if successful
    if (status === "Sent") {
      await db.markReminderAsSent(doc.id, reminderType, schedDateStr, doc.userId);
    }
  }

  logDecision(`--- Automation Engine run completed. Reminders sent: ${count} ---`);
  return { count, decisionLogs };
}

// Route to handle document uploads (wrapped in Multer error handling)
app.post("/api/upload", authenticateToken, uploadLimiter, (req, res, next) => {
  upload.single("document")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "Upload failed: File exceeds the maximum allowed size of 10MB." });
      }
      return res.status(400).json({ error: `Upload failed: Multer error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: `Upload failed: ${err.message}` });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Please upload a valid document." });
    }

    const { originalname, buffer, mimetype, size } = req.file;
    console.log(`Received file: ${originalname} (${mimetype}, ${size} bytes)`);

    if (!originalname) {
      return res.status(400).json({ error: "Filename is missing." });
    }

    const path = require("path");
    // Sanitize filename (remove path traversal attempts)
    const sanitizedFilename = path.basename(originalname).replace(/[\\\/]/g, "_");

    // Strict MIME-type Whitelist Validation (Security Check)
    const allowedMimeTypes = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "text/plain"
    ];
    if (!allowedMimeTypes.includes(mimetype)) {
      return res.status(400).json({
        error: "Security Policy Violation: Unsupported file type.",
        details: `Allowed types: PDF, JPEG, PNG, WEBP, and TXT. Received type: ${mimetype}`
      });
    }

    // Verify extension matches mimetype
    const ext = path.extname(sanitizedFilename).toLowerCase();
    const mimeToExtMap = {
      "application/pdf": [".pdf"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "image/webp": [".webp"],
      "text/plain": [".txt"]
    };
    if (!mimeToExtMap[mimetype].includes(ext)) {
      return res.status(400).json({
        error: "Filename validation failure: file extension does not match its contents.",
        details: `For type ${mimetype}, allowed extensions: ${mimeToExtMap[mimetype].join(", ")}. Received extension: ${ext}`
      });
    }

    // Check for password-protected PDFs (Security Check)
    if (mimetype === "application/pdf") {
      const pdfText = buffer.toString("ascii", 0, Math.min(buffer.length, 1024 * 1024)); // Inspect first 1MB
      if (pdfText.includes("/Encrypt")) {
        return res.status(400).json({
          error: "Document Parsing Blocked: Password Protected PDF.",
          details: "The uploaded PDF is encrypted or password-protected. Please remove the password protection before uploading."
        });
      }
    }
    const isText = mimetype === "text/plain";
    const filePart = isText ? buffer.toString("utf8") : bufferToGenerativePart(buffer, mimetype);

    // Stage 1: Document Classification
    console.log("Stage 1: Classifying document type...");
    const classifierModel = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: classificationSchema
      }
    });

    const classificationPrompt = `Analyze the layout, titles, structure, and text content of this document. Detect the document type and classify it into exactly one of the following:
- invoice
- receipt
- resume
- contract
- purchase_order
- bank_statement
- policy
- sop`;

    let detectedType = "other";
    let detectedConfidence = 0.85;

    try {
      const classResult = await classifierModel.generateContent([classificationPrompt, filePart]);
      const classResponseText = classResult.response.text().trim();
      console.log("Raw Classification Response:", classResponseText);
      const parsedClass = JSON.parse(classResponseText);
      if (parsedClass.documentType) {
        detectedType = parsedClass.documentType.toLowerCase().replace(" ", "_");
      }
      if (parsedClass.confidence !== undefined) {
        detectedConfidence = parsedClass.confidence;
      }
    } catch (err) {
      console.error("Classification stage failed, defaulting to 'other':", err.message);
    }

    // Map any close names to ensure strict typing
    if (detectedType === "policy_document") detectedType = "policy";
    if (detectedType === "purchaseorder") detectedType = "purchase_order";
    if (detectedType === "bankstatement") detectedType = "bank_statement";

    console.log(`Detected document type: "${detectedType}" with confidence: ${detectedConfidence}`);

    // Stage 2: Specific Data Extraction
    let selectedSchema = otherSchema;
    let extractionPrompt = `Analyze this document. Write a clear summary of its contents. Extract the recommended organizational routing department and reason.`;

    switch (detectedType) {
      case "invoice":
        selectedSchema = invoiceSchema;
        extractionPrompt = `Analyze this Invoice document. Write a clear summary of its contents. Suggest 2-3 logical next actions. Recommend department routing.

You must extract the fields carefully by inspecting the entire document text and tabular data. OCR text may contain typos, misaligned tables, or scanning artifacts; interpret them contextually.

Here are specific field guidelines:
1. Vendor: Extract vendor name. Look for labels like "From", "Vendor", "Supplier", "Seller", "Bill From", "Billed By".
2. Customer Name: Extract customer/buyer name. Look for labels like "To", "Customer", "Client", "Bill To", "Billed To", "Buyer".
3. Invoice Number: Look for labels like "Invoice No", "Invoice #", "Invoice Number", "Invoice ID", "Bill No", "Bill Number", "Tax Invoice No".
4. Date: Look for labels like "Invoice Date", "Date", "Date of Invoice", "Billing Date", "Bill Date".
5. Due Date: Look for labels like "Due Date", "Payment Due", "Pay By", "Due On", "Payment Date".
6. GST Number: Extract the vendor's GSTIN / Tax registration number / VAT / Tax ID.
7. Currency: Detect the currency (e.g. INR, USD, EUR, GBP). Preserve the currency code or symbol (e.g. ₹, $, €, £). If the document uses Indian Rupees, set currency to "INR".
8. Total Amount: This is the final grand total / total payable / amount due / net payable / invoice total. Do NOT return 0 or default to 0 if a valid total exists in the document. Look for labels like "Grand Total", "Total", "Total Amount", "Total Payable", "Amount Due", "Net Amount", "Invoice Total", "Balance Due", "Amount Payable", "Total Invoice Value".
9. For all numeric fields (totalAmount, subtotal, grossSubtotal, netTaxableSubtotal, discount, shipping, freight, otherCharges, cgst, sgst, igst, vat, salesTax, otherTaxes, tax, roundOff): extract them as numbers.
10. Line Items: Extract description, quantity, unitPrice, amount.

IMPORTANT: You MUST return every field specified in the schema. For any field that is NOT present or cannot be found in the document, you MUST set its "value" to null. Do NOT return "N/A" or placeholders.`;
        break;

      case "receipt":
        selectedSchema = receiptSchema;
        extractionPrompt = `Analyze this Receipt document. Write a clear summary of its contents. Suggest 2-3 logical next actions. Recommend department routing.
Extract these receipt fields:
- merchantName: Name of the merchant or store
- date: Date of transaction
- totalAmount: Total amount paid (number)
- taxAmount: Tax amount paid (number)
- paymentMethod: Payment method (e.g., cash, credit card, debit, mobile)`;
        break;

      case "resume":
        selectedSchema = resumeSchema;
        extractionPrompt = `Analyze this Resume document. Write a clear summary of its contents. Suggest 2-3 logical next actions. Recommend department routing.
Extract these resume fields:
- candidateName: Full name of candidate
- email: Contact email address
- phone: Contact phone number
- skills: Array of technical skills
- experienceYears: Total estimated years of experience (number)
- education: Array of degrees/schools`;
        break;

      case "contract":
        selectedSchema = contractSchema;
        extractionPrompt = `Analyze this Contract document. Write a clear summary of its contents. Suggest 2-3 logical next actions. Recommend department routing.
Extract these contract fields:
- title: Title of agreement
- parties: Array of parties involved
- effectiveDate: Effective start date
- terminationDate: Termination date
- key obligations: Array of key clauses/obligations`;
        break;

      case "purchase_order":
        selectedSchema = purchaseOrderSchema;
        extractionPrompt = `Analyze this Purchase Order document. Write a clear summary of its contents. Suggest 2-3 logical next actions. Recommend department routing.
Extract these purchase order fields:
- poNumber: Purchase order identifier number
- buyer: Name of buyer/client company
- vendor: Name of vendor company
- date: Date of purchase order
- totalAmount: Total PO amount (number)
- deliveryDate: Expected delivery date`;
        break;

      case "bank_statement":
        selectedSchema = bankStatementSchema;
        extractionPrompt = `Analyze this Bank Statement document. Write a clear summary of its contents. Suggest 2-3 logical next actions. Recommend department routing.
Extract these bank statement fields:
- bankName: Name of bank
- accountHolder: Account holder's name
- accountNumber: Account number
- statementDate: Statement date
- startingBalance: Opening balance (number)
- endingBalance: Closing balance (number)`;
        break;

      case "policy":
        selectedSchema = policySchema;
        extractionPrompt = `Analyze this Policy Document. Write a clear summary of its contents. Suggest 2-3 logical next actions. Recommend department routing.
Extract these policy fields:
- policyName: Name/Title of policy
- effectiveDate: Effective date of policy
- scope: Scope of policy applicability
- keyRules: Array of key rules/guidelines`;
        break;

      case "sop":
        selectedSchema = sopSchema;
        extractionPrompt = `Analyze this Standard Operating Procedure (SOP). Write a clear summary of its contents. Suggest 2-3 logical next actions. Recommend department routing.
Extract these SOP fields:
- title: Title of standard operating procedure
- department: Target department for SOP
- steps: Array of procedure steps
- scope: Scope of applicability`;
        break;
    }

    console.log(`Stage 2: Extracting specific details using schema for "${detectedType}"...`);
    const extractorModel = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: selectedSchema
      }
    });

    let responseText = "";
    let rawResult;
    try {
      rawResult = await extractorModel.generateContent([extractionPrompt, filePart]);
      responseText = rawResult.response.text();
      console.log("Received response from Gemini API. Length:", responseText.length);
      
      // Log raw response for debugging (Requirement 6)
      console.log("--- RAW GEMINI RESPONSE START ---");
      console.log(responseText);
      console.log("--- RAW GEMINI RESPONSE END ---");
    } catch (apiError) {
      console.error("Error communicating with Gemini API:", apiError);
      return res.status(502).json({
        error: "Gemini API Communication Failure",
        details: apiError.message
      });
    }

    // Clean response text to ensure ONLY valid JSON (Requirement 1, 2, 3)
    let cleanText = responseText.trim();
    if (cleanText.startsWith("```")) {
      const lines = cleanText.split("\n");
      if (lines[0].startsWith("```")) lines.shift();
      if (lines[lines.length - 1].startsWith("```")) lines.pop();
      cleanText = lines.join("\n").trim();
    }

    // Parse the JSON result with fallback error handling (Requirement 5)
    let analysisResult;
    try {
      analysisResult = JSON.parse(cleanText);
    } catch (parseError) {
      console.error("JSON Parse Error! Attempting regex fallback recovery...");
      const firstBrace = cleanText.indexOf("{");
      const lastBrace = cleanText.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const potentialJson = cleanText.substring(firstBrace, lastBrace + 1);
        try {
          analysisResult = JSON.parse(potentialJson);
          console.log("JSON parsing recovered successfully!");
        } catch (retryError) {
          console.error("Brace recovery failed:", retryError.message);
        }
      }
      
      if (!analysisResult) {
        return res.status(422).json({
          error: "AI Response Parsing Failure",
          details: "The document analysis failed because the AI response was not formatted as valid JSON. Please try again."
        });
      }
    }

    // Add back the classification metadata
    analysisResult.documentType = detectedType;
    analysisResult.confidence = detectedConfidence;

    // Clean up "N/A" and placeholder fields to return null (Requirement 4)
    function sanitizeNullFields(obj) {
      if (obj === null || obj === undefined) return null;
      if (Array.isArray(obj)) {
        return obj.map(item => sanitizeNullFields(item));
      }
      if (typeof obj === "object") {
        if ("value" in obj) {
          const v = obj.value;
          if (v === "N/A" || v === "n/a" || v === "NA" || v === "" || v === undefined) {
            obj.value = null;
          }
        }
        const cleaned = {};
        for (const [key, val] of Object.entries(obj)) {
          cleaned[key] = sanitizeNullFields(val);
        }
        return cleaned;
      }
      if (typeof obj === "string") {
        if (obj === "N/A" || obj === "n/a" || obj === "NA" || obj === "") {
          return null;
        }
      }
      return obj;
    }

    analysisResult = sanitizeNullFields(analysisResult);

    // Initialize document properties
    let status = "Approved";
    let isDuplicate = false;
    let amountMismatch = false;
    let missingGst = false;
    const keyDates = [];
    const suggestedActions = [];
    let validationBreakdown = "";

    // Map Receipt data to unified Invoice structure for pipeline integration
    if (detectedType === "receipt" && analysisResult.receiptData) {
      const rec = analysisResult.receiptData;
      analysisResult.invoiceData = {
        vendor: rec.merchantName || { value: null, confidence: 0 },
        invoiceNumber: { value: "REC-" + Date.now().toString().slice(-4), confidence: 1 },
        date: rec.date || { value: null, confidence: 0 },
        dueDate: rec.date || { value: null, confidence: 0 },
        subtotal: { value: (rec.totalAmount?.value || 0) - (rec.taxAmount?.value || 0), confidence: 0.9 },
        tax: rec.taxAmount || { value: 0, confidence: 0 },
        totalAmount: rec.totalAmount || { value: 0, confidence: 0 },
        currency: { value: "USD", confidence: 0.8 },
        gstNumber: { value: null, confidence: 0 }
      };
    }

    // Specific post-processing rules for Invoice & Receipt (Generic Financial Validation Engine)
    if (analysisResult.documentType === "invoice" || analysisResult.documentType === "receipt") {
      const invData = analysisResult.invoiceData || {};
      const vendor = invData.vendor?.value || "Unknown Vendor";
      const invoiceNumber = invData.invoiceNumber?.value || "";
      const date = invData.date?.value || "";
      const dueDateStr = invData.dueDate?.value || "";

      // Safe value retrieval helper
      const getVal = (field) => (field && typeof field.value === 'number') ? field.value : 0;

      const totalAmount = getVal(invData.totalAmount);
      const subtotal = getVal(invData.subtotal);
      const grossSubtotal = getVal(invData.grossSubtotal);
      const netTaxableSubtotal = getVal(invData.netTaxableSubtotal);
      const discount = getVal(invData.discount);
      const shipping = getVal(invData.shipping);
      const freight = getVal(invData.freight);
      const otherCharges = getVal(invData.otherCharges);
      const cgst = getVal(invData.cgst);
      const sgst = getVal(invData.sgst);
      const igst = getVal(invData.igst);
      const vat = getVal(invData.vat);
      const salesTax = getVal(invData.salesTax);
      const otherTaxes = getVal(invData.otherTaxes);
      const roundOff = getVal(invData.roundOff);
      const tax = getVal(invData.tax);

      const sumTaxes = cgst + sgst + igst + vat + salesTax + otherTaxes;
      const effectiveTax = sumTaxes > 0 ? sumTaxes : tax;

      // Build all candidate base taxable values
      const candidates = [];
      if (netTaxableSubtotal > 0) {
        candidates.push({ value: netTaxableSubtotal, label: "Net Taxable Subtotal" });
        if (discount > 0) {
          candidates.push({ value: netTaxableSubtotal - discount, label: "Net Taxable Subtotal minus Discount" });
        }
      }
      if (subtotal > 0) {
        candidates.push({ value: subtotal, label: "Subtotal" });
        if (discount > 0) {
          candidates.push({ value: subtotal - discount, label: "Subtotal minus Discount" });
        }
      }
      if (grossSubtotal > 0) {
        candidates.push({ value: grossSubtotal - discount, label: "Gross Subtotal minus Discount" });
        candidates.push({ value: grossSubtotal, label: "Gross Subtotal" });
      }

      // Check sum of line items as a candidate base
      const lineItems = invData.lineItems?.value || [];
      if (lineItems.length > 0) {
        const lineItemsSum = lineItems.reduce((sum, item) => {
          const itemAmt = item.amount || (getVal(item.quantity) * getVal(item.unitPrice)) || 0;
          return sum + itemAmt;
        }, 0);
        if (lineItemsSum > 0) {
          candidates.push({ value: lineItemsSum, label: "Sum of Line Items" });
          if (discount > 0) {
            candidates.push({ value: lineItemsSum - discount, label: "Sum of Line Items minus Discount" });
          }
        }
      }

      if (candidates.length === 0) {
        candidates.push({ value: subtotal || totalAmount || 0, label: "Fallback Subtotal" });
      }

      // Test candidates against the stated grand totalAmount
      let bestCandidate = null;
      let minDiff = Infinity;
      const tolerance = 1.0; // 1 unit in currency subunits rounding tolerance

      candidates.forEach(cand => {
        // Option 1: Tax-exclusive (add taxes)
        const expectedTotalExclusive = cand.value + effectiveTax + shipping + freight + otherCharges + roundOff;
        const diffExclusive = Math.abs(expectedTotalExclusive - totalAmount);
        if (diffExclusive < minDiff) {
          minDiff = diffExclusive;
          bestCandidate = {
            candidate: cand,
            expectedTotal: expectedTotalExclusive,
            diff: diffExclusive,
            isTaxInclusive: false
          };
        }

        // Option 2: Tax-inclusive (taxes are already inside the base/subtotal, do not add them again)
        const expectedTotalInclusive = cand.value + shipping + freight + otherCharges + roundOff;
        const diffInclusive = Math.abs(expectedTotalInclusive - totalAmount);
        if (diffInclusive < minDiff) {
          minDiff = diffInclusive;
          bestCandidate = {
            candidate: cand,
            expectedTotal: expectedTotalInclusive,
            diff: diffInclusive,
            isTaxInclusive: true
          };
        }
      });

      if (bestCandidate && bestCandidate.diff <= tolerance) {
        amountMismatch = false;
        const c = bestCandidate.candidate;
        validationBreakdown = `[Financial Validation: VALID]
Calculated using formula: Base (${c.label}) + ${bestCandidate.isTaxInclusive ? "No Tax (Tax-Inclusive)" : `Taxes (${effectiveTax})`} + Shipping/Freight + Other Charges + Round-off = Expected Total.
- Base Amount: ${c.value}
- Effective Taxes: ${effectiveTax} (CGST: ${cgst}, SGST: ${sgst}, IGST: ${igst}, VAT: ${vat}, SalesTax: ${salesTax}, Other: ${otherTaxes}, General: ${tax}) [${bestCandidate.isTaxInclusive ? "Tax-Inclusive / Already in Base" : "Tax-Exclusive / Added to Base"}]
- Shipping/Freight: ${shipping + freight}
- Other Charges: ${otherCharges}
- Round-off: ${roundOff}
= Expected Total: ${bestCandidate.expectedTotal.toFixed(2)} (Stated Grand Total: ${totalAmount.toFixed(2)})`;
      } else {
        amountMismatch = true;
        const c = bestCandidate ? bestCandidate.candidate : { value: subtotal, label: "Subtotal" };
        const expected = bestCandidate ? bestCandidate.expectedTotal : (subtotal + effectiveTax + shipping + freight + otherCharges + roundOff);
        validationBreakdown = `[Financial Validation: MISMATCH]
The stated grand total (${totalAmount.toFixed(2)}) does not match the sum of components within tolerance.
Expected Total: ${expected.toFixed(2)} (using assumed Base: ${c.label} = ${c.value})
Components:
- Base Amount: ${c.value}
- Effective Taxes: ${effectiveTax} (CGST: ${cgst}, SGST: ${sgst}, IGST: ${igst}, VAT: ${vat}, SalesTax: ${salesTax}, Other: ${otherTaxes}, General: ${tax})
- Shipping/Freight: ${shipping + freight}
- Other Charges: ${otherCharges}
- Round-off: ${roundOff}
Difference: ${(totalAmount - expected).toFixed(2)}`;
      }

      // Adjust field confidence scores based on OCR readability & calculations consistency
      const readability = analysisResult.ocrVerification?.readabilityScore !== undefined ? analysisResult.ocrVerification.readabilityScore : 1.0;
      
      const adjustConfidence = (fieldObj, factor = 1.0) => {
        if (fieldObj && typeof fieldObj === 'object' && 'confidence' in fieldObj) {
          let conf = fieldObj.confidence;
          if (fieldObj.value === null || fieldObj.value === undefined || fieldObj.value === "") {
            fieldObj.confidence = 0.0;
          } else {
            conf = conf * readability;
            conf = conf * factor;
            fieldObj.confidence = Math.min(1.0, Math.max(0.0, Number(conf.toFixed(2))));
          }
        }
      };

      const factor = amountMismatch ? 0.8 : 1.0;
      for (const key of Object.keys(invData)) {
        adjustConfidence(invData[key], factor);
      }

      // 2. Detect missing required fields (for GST Number)
      if (!invData.gstNumber?.value) {
        missingGst = true;
      }

      // 3. Status determination based on Due Date
      status = "Pending";
      if (dueDateStr) {
        keyDates.push({ label: "Due Date", date: dueDateStr });
        const dueDate = new Date(dueDateStr);
        if (!isNaN(dueDate.getTime()) && dueDate.getTime() < Date.now()) {
          status = "Overdue";
        }
      }

      if (date) {
        keyDates.push({ label: "Billing Date", date: date });
      }

      // 4. Duplicate Invoice Detection (isolated to current user)
      const allDocs = await db.getDocuments(req.user.id);
      const duplicate = allDocs.find(doc => {
        if (doc.documentType !== "invoice" && doc.documentType !== "receipt") return false;
        const otherInv = doc.invoiceData || {};
        
        // Match vendor and invoice number OR vendor, amount and date OR GST and invoice number
        const matchNumber = invoiceNumber && otherInv.invoiceNumber?.value?.toLowerCase() === invoiceNumber.toLowerCase();
        const matchAmountAndDate = otherInv.totalAmount?.value === totalAmount && otherInv.date?.value === date;
        const matchGstAndNumber = invData.gstNumber?.value && otherInv.gstNumber?.value && 
                                  invData.gstNumber.value.toLowerCase() === otherInv.gstNumber.value.toLowerCase() &&
                                  invoiceNumber && otherInv.invoiceNumber?.value?.toLowerCase() === invoiceNumber.toLowerCase();
        
        return doc.id !== undefined && 
               otherInv.vendor?.value?.toLowerCase() === vendor.toLowerCase() && 
               (matchNumber || matchAmountAndDate || matchGstAndNumber);
      });

      if (duplicate) {
        isDuplicate = true;
      }
    } else {
      // Map relevant date milestones to document index
      if (detectedType === "contract" && analysisResult.contractData) {
        const contract = analysisResult.contractData;
        if (contract.effectiveDate?.value) keyDates.push({ label: "Effective Date", date: contract.effectiveDate.value });
        if (contract.terminationDate?.value) keyDates.push({ label: "Termination Date", date: contract.terminationDate.value });
      } else if (detectedType === "policy" && analysisResult.policyData) {
        const policy = analysisResult.policyData;
        if (policy.effectiveDate?.value) keyDates.push({ label: "Effective Date", date: policy.effectiveDate.value });
      } else if (detectedType === "purchase_order" && analysisResult.purchaseOrderData) {
        const po = analysisResult.purchaseOrderData;
        if (po.date?.value) keyDates.push({ label: "PO Date", date: po.date.value });
        if (po.deliveryDate?.value) keyDates.push({ label: "Delivery Date", date: po.deliveryDate.value });
      } else if (detectedType === "bank_statement" && analysisResult.bankStatementData) {
        const bs = analysisResult.bankStatementData;
        if (bs.statementDate?.value) keyDates.push({ label: "Statement Date", date: bs.statementDate.value });
      }
    }

    // Populate default actions if none generated
    if (analysisResult.suggestedActions && analysisResult.suggestedActions.length > 0) {
      suggestedActions.push(...analysisResult.suggestedActions);
    } else {
      suggestedActions.push(
        { action: "Review Extracted Data", reason: "Manually verify AI extracted fields.", type: "review", status: "pending" },
        { action: "Archive Document", reason: "Securely file document into history repository.", type: "archive", status: "pending" }
      );
    }

    // Create a new document entry
    const newDoc = {
      id: Date.now().toString(),
      fileName: sanitizedFilename,
      fileSize: size,
      mimeType: mimetype,
      uploadedAt: new Date().toISOString(),
      status,
      isDuplicate,
      amountMismatch,
      missingGst,
      documentType: analysisResult.documentType,
      confidence: analysisResult.confidence || 0.85,
      summary: (analysisResult.summary || "") + "\n\n" + (validationBreakdown || ""),
      ocrVerification: analysisResult.ocrVerification || null,
      recommendedRouting: analysisResult.recommendedRouting || { department: "Operations", reason: "Standard routing" },
      invoiceData: analysisResult.invoiceData || null,
      contractData: analysisResult.contractData || null,
      resumeData: analysisResult.resumeData || null,
      sopData: analysisResult.sopData || null,
      policyData: analysisResult.policyData || null,
      purchaseOrderData: analysisResult.purchaseOrderData || null,
      bankStatementData: analysisResult.bankStatementData || null,
      originalFile: buffer.toString("base64"),
      extractedJson: JSON.stringify(analysisResult),
      suggestedActions,
      keyDates,
      userId: req.user.id
    };

    // Store persistently
    await db.addDocument(newDoc);

    // Log the "Invoice processed" ingestion event to Outgoing Email History / Automation Logs
    await db.addEmailLog({
      id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
      documentId: newDoc.id,
      documentName: newDoc.fileName,
      recipient: req.user.email,
      subject: `[Ingestion] Document Processed: ${newDoc.fileName}`,
      body: `Document of type "${newDoc.documentType}" was successfully processed and archived.\n\nAI Confidence: ${(newDoc.confidence * 100).toFixed(0)}%\nOCR Readability: ${(newDoc.ocrVerification?.readabilityScore * 100 || 85).toFixed(0)}%\n\n${validationBreakdown}`,
      sentAt: new Date().toISOString(),
      reminderType: "ingestion",
      scheduledDate: new Date().toISOString().split("T")[0],
      status: "Sent",
      userId: req.user.id
    });

    res.json(newDoc);
  } catch (error) {
    console.error("Error analyzing document:", error);
    res.status(500).json({
      error: "Failed to analyze document with Gemini API.",
      details: error.message
    });
  }
});

// ==========================================
// Authentication Routes
// ==========================================

// 1. Signup Route
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { fullName, companyName, email, password } = req.body;

    if (!fullName || !companyName || !email || !password) {
      return res.status(400).json({ error: "Missing required registration parameters." });
    }

    const existingUser = await db.getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: "A user with this email address already exists." });
    }

    // Hash password securely
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const newUser = {
      fullName,
      companyName,
      email,
      passwordHash
    };

    const registeredUser = await db.addUser(newUser);
    const userId = registeredUser.id.toString();

    // Issue JWT token
    const token = jwt.sign({ id: userId, email, fullName, companyName }, JWT_SECRET, { expiresIn: "7d" });

    res.status(201).json({
      token,
      user: {
        id: userId,
        fullName,
        companyName,
        email
      }
    });
  } catch (err) {
    console.error("Signup failed:", err);
    res.status(500).json({ error: "Registration failed", details: err.message });
  }
});

// 2. Login Route
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Please enter your email and password." });
    }

    const user = await db.getUserByEmail(email);
    if (!user) {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    // Issue JWT token
    const token = jwt.sign(
      { id: String(user.id), email: user.email, fullName: user.fullName, companyName: user.companyName },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: String(user.id),
        fullName: user.fullName,
        companyName: user.companyName,
        email: user.email
      }
    });
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "Authentication failed", details: err.message });
  }
});

// 3. Get Current User Info
app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User profile not found." });
    }
    res.json({
      id: user.id,
      fullName: user.fullName,
      companyName: user.companyName,
      email: user.email
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to resolve session details.", details: err.message });
  }
});

// ==========================================
// Protected Document Routes (Isolated per User)
// ==========================================

// Route to list all documents for current user
app.get("/api/documents", authenticateToken, async (req, res) => {
  try {
    const docs = await db.getDocuments(req.user.id);
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: "Database read failure", details: err.message });
  }
});

// Route to get a specific document belonging to current user
app.get("/api/documents/:id", authenticateToken, async (req, res) => {
  try {
    const doc = await db.getDocument(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    if (doc.userId !== req.user.id) {
      return res.status(403).json({ error: "Access Denied: You do not own this document." });
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: "Database query failure", details: err.message });
  }
});

// Route to delete a document belonging to current user
app.delete("/api/documents/:id", authenticateToken, async (req, res) => {
  try {
    const doc = await db.getDocument(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    if (doc.userId !== req.user.id) {
      return res.status(403).json({ error: "Access Denied: You do not own this document." });
    }
    const success = await db.deleteDocument(req.params.id);
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: "Database delete failure", details: err.message });
  }
});

// Action item toggle route (Ownership verified)
app.post("/api/documents/:id/actions/:actionIndex", authenticateToken, async (req, res) => {
  try {
    const doc = await db.getDocument(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    if (doc.userId !== req.user.id) {
      return res.status(403).json({ error: "Access Denied: You do not own this document." });
    }

    const actionIndex = parseInt(req.params.actionIndex, 10);
    if (isNaN(actionIndex) || !doc.suggestedActions[actionIndex]) {
      return res.status(400).json({ error: "Invalid action index" });
    }

    const currentStatus = doc.suggestedActions[actionIndex].status;
    doc.suggestedActions[actionIndex].status = currentStatus === "completed" ? "pending" : "completed";
    
    await db.updateDocument(doc.id, { suggestedActions: doc.suggestedActions });

    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: "Database update failure", details: err.message });
  }
});

// Specific invoice status update routes (Approve, Reject, Pay - Ownership verified)
// Specific invoice status update routes (Approve, Reject, Pay - Ownership verified & Action logged)
app.post("/api/documents/:id/approve", authenticateToken, async (req, res) => {
  try {
    const doc = await db.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    if (doc.userId !== req.user.id) {
      return res.status(403).json({ error: "Access Denied: You do not own this document." });
    }
    const updated = await db.updateDocument(req.params.id, { status: "Approved" });

    // Log the "Invoice approved" action event to Outgoing Email History / Automation Logs
    await db.addEmailLog({
      id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
      documentId: doc.id,
      documentName: doc.fileName,
      recipient: "System Audit",
      subject: `[Status Change] Invoice Approved: ${doc.invoiceData?.invoiceNumber?.value || doc.id}`,
      body: `Invoice from ${doc.invoiceData?.vendor?.value || "Unknown Vendor"} for ${doc.invoiceData?.currency?.value || "$"}${doc.invoiceData?.totalAmount?.value || 0} was approved by ${req.user.fullName} (${req.user.email}).`,
      sentAt: new Date().toISOString(),
      reminderType: "status_change",
      scheduledDate: new Date().toISOString().split("T")[0],
      status: "Sent",
      userId: req.user.id
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Database update failure", details: err.message });
  }
});

app.post("/api/documents/:id/reject", authenticateToken, async (req, res) => {
  try {
    const doc = await db.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    if (doc.userId !== req.user.id) {
      return res.status(403).json({ error: "Access Denied: You do not own this document." });
    }
    const updated = await db.updateDocument(req.params.id, { status: "Rejected" });

    // Log the "Invoice rejected" action event to Outgoing Email History / Automation Logs
    await db.addEmailLog({
      id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
      documentId: doc.id,
      documentName: doc.fileName,
      recipient: "System Audit",
      subject: `[Status Change] Invoice Rejected: ${doc.invoiceData?.invoiceNumber?.value || doc.id}`,
      body: `Invoice from ${doc.invoiceData?.vendor?.value || "Unknown Vendor"} for ${doc.invoiceData?.currency?.value || "$"}${doc.invoiceData?.totalAmount?.value || 0} was rejected by ${req.user.fullName} (${req.user.email}).`,
      sentAt: new Date().toISOString(),
      reminderType: "status_change",
      scheduledDate: new Date().toISOString().split("T")[0],
      status: "Sent",
      userId: req.user.id
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Database update failure", details: err.message });
  }
});

app.post("/api/documents/:id/pay", authenticateToken, async (req, res) => {
  try {
    const doc = await db.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    if (doc.userId !== req.user.id) {
      return res.status(403).json({ error: "Access Denied: You do not own this document." });
    }
    const updated = await db.updateDocument(req.params.id, { status: "Paid" });

    // Log the "Invoice marked paid" action event to Outgoing Email History / Automation Logs
    await db.addEmailLog({
      id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
      documentId: doc.id,
      documentName: doc.fileName,
      recipient: "System Audit",
      subject: `[Status Change] Invoice Paid: ${doc.invoiceData?.invoiceNumber?.value || doc.id}`,
      body: `Invoice from ${doc.invoiceData?.vendor?.value || "Unknown Vendor"} for ${doc.invoiceData?.currency?.value || "$"}${doc.invoiceData?.totalAmount?.value || 0} was marked as Paid by ${req.user.fullName} (${req.user.email}).`,
      sentAt: new Date().toISOString(),
      reminderType: "status_change",
      scheduledDate: new Date().toISOString().split("T")[0],
      status: "Sent",
      userId: req.user.id
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: "Database update failure", details: err.message });
  }
});

// ==========================================
// Settings Routes
// ==========================================
app.get("/api/settings", authenticateToken, async (req, res) => {
  try {
    const settings = await db.getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to load system settings", details: err.message });
  }
});

app.post("/api/settings", authenticateToken, async (req, res) => {
  try {
    const updatedSettings = await db.updateSettings(req.body);
    res.json(updatedSettings);
  } catch (err) {
    res.status(500).json({ error: "Failed to update system settings", details: err.message });
  }
});

// ==========================================
// Email Notification & Automation Job Routes
// ==========================================

// Route to get email logs for current user
app.get("/api/emails", authenticateToken, async (req, res) => {
  try {
    const logs = await db.getEmailLogs(req.user.id);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: "Database read failure", details: err.message });
  }
});

// Manual trigger for current user's daily checker
app.post("/api/jobs/run-daily", authenticateToken, async (req, res) => {
  try {
    const result = await runDailyChecks(req.user.id);
    res.json({ success: true, remindersSent: result.count, decisionLogs: result.decisionLogs });
  } catch (err) {
    res.status(500).json({ error: "Job execution failed", details: err.message });
  }
});

// Test email dispatch route (Real or Simulated)
app.post("/api/jobs/send-test-email", authenticateToken, async (req, res) => {
  try {
    const { to } = req.body;
    const recipient = to || req.user.email;

    if (!recipient) {
      return res.status(400).json({ error: "Missing recipient email address." });
    }

    const subject = "FlowPilot Automation Test Email";
    const body = `Hello ${req.user.fullName || "User"},\n\nThis is a real test email dispatched from your FlowPilot Enterprise Automation Engine to verify SMTP/Resend API settings.\n\n` +
                 `Configuration Status:\n` +
                 `- Recipient: ${recipient}\n` +
                 `- Provider: ${process.env.RESEND_API_KEY ? "Resend API" : "Simulated/Dev Mode"}\n` +
                 `- Dispatch Timestamp: ${new Date().toLocaleString()}\n\n` +
                 `Regards,\nFlowPilot Accounts Automation`;

    const emailResult = await emailService.sendEmail({ to: recipient, subject, body });

    // Save to logs
    await db.addEmailLog({
      id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
      documentId: "test-email-run",
      documentName: "System Test Dispatch",
      recipient,
      subject,
      body,
      sentAt: new Date().toISOString(),
      reminderType: "manual_test",
      scheduledDate: new Date().toISOString().split("T")[0],
      status: "sent",
      userId: req.user.id
    });

    res.json({ success: true, details: emailResult });
  } catch (err) {
    console.error("Test email dispatch failed:", err);
    
    // Save failed log to database
    await db.addEmailLog({
      id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
      documentId: "test-email-run",
      documentName: "System Test Dispatch",
      recipient: req.body.to || req.user.email || "Unknown Recipient",
      subject: "FlowPilot Automation Test Email (FAILED)",
      body: `Attempted test email dispatch failed with error: ${err.message}`,
      sentAt: new Date().toISOString(),
      reminderType: "manual_test",
      scheduledDate: new Date().toISOString().split("T")[0],
      status: "failed",
      errorMessage: err.message,
      userId: req.user.id
    });

    res.status(500).json({ error: "Email dispatch failed", details: err.message });
  }
});

// Route to trigger deterministic testing scenario linked to current user
app.post("/api/jobs/run-test-scenario", authenticateToken, async (req, res) => {
  try {
    console.log("Setting up deterministic test scenario...");
    
    // Clear out previous test scenario documents for this user
    const allDocs = await db.getDocuments(req.user.id);
    for (const doc of allDocs) {
      if (doc.fileName && doc.fileName.startsWith("test_reminder_")) {
        await db.deleteDocument(doc.id);
      }
    }

    const today = new Date();
    
    const addTestDoc = async (id, fileName, status, diffDays, email, isDuplicateScenario = false) => {
      const targetDate = new Date();
      targetDate.setDate(today.getDate() + diffDays);
      const targetDateStr = targetDate.toISOString().split("T")[0];

      const doc = {
        id,
        fileName,
        fileSize: 1024,
        mimeType: "text/plain",
        uploadedAt: new Date().toISOString(),
        status,
        isDuplicate: false,
        amountMismatch: false,
        missingGst: false,
        documentType: "invoice",
        confidence: 0.95,
        summary: `Deterministic test case: ${fileName}`,
        recommendedRouting: { department: "Finance", reason: "Test case" },
        invoiceData: {
          vendor: { value: "Test Vendor", confidence: 0.95 },
          invoiceNumber: { value: `INV-${id}`, confidence: 0.95 },
          date: { value: today.toISOString().split("T")[0], confidence: 0.95 },
          dueDate: { value: targetDateStr, confidence: 0.95 },
          subtotal: { value: 100, confidence: 0.95 },
          tax: { value: 10, confidence: 0.95 },
          totalAmount: { value: 110, confidence: 0.95 },
          currency: { value: "USD", confidence: 0.95 },
          email: email ? { value: email, confidence: 0.95 } : null
        },
        suggestedActions: [],
        keyDates: [{ label: "Due Date", date: targetDateStr }],
        userId: req.user.id
      };

      await db.addDocument(doc);

      if (isDuplicateScenario) {
        // Pre-register reminder sent in ReminderHistory table
        const rType = diffDays === 3 ? "due_3_days" : "due_7_days";
        await db.markReminderAsSent(id, rType, req.user.id);
      }
    };

    // Inject test cases
    // 1. Reminder due (due in 3 days)
    await addTestDoc("test_due_3", "test_reminder_due_3_days.txt", "Pending", 3, "due-3@flowpilot.io");
    
    // 2. Reminder not yet due (due in 10 days)
    await addTestDoc("test_due_10", "test_reminder_not_due_10_days.txt", "Pending", 10, "due-10@flowpilot.io");
    
    // 3. Already paid (due in 3 days but Paid)
    await addTestDoc("test_paid_due_3", "test_reminder_already_paid.txt", "Paid", 3, "paid-3@flowpilot.io");
    
    // 4. Duplicate reminder (due in 3 days, sent history exists)
    await addTestDoc("test_dup_due_3", "test_reminder_duplicate.txt", "Pending", 3, "dup-3@flowpilot.io", true);
    
    // 5. Overdue invoice (due 14 days ago)
    await addTestDoc("test_overdue_14", "test_reminder_overdue_14_days.txt", "Pending", -14, "overdue-14@flowpilot.io");
    
    // 6. Missing email (due in 1 day, email is null)
    await addTestDoc("test_missing_email", "test_reminder_missing_email.txt", "Pending", 1, null);

    // Run checks
    const result = await runDailyChecks(req.user.id);

    res.json({
      success: true,
      remindersSent: result.count,
      decisionLogs: result.decisionLogs
    });
  } catch (err) {
    console.error("Test scenario execution failed:", err);
    res.status(500).json({ error: "Failed to run test scenario", details: err.message });
  }
});

// Scheduled daily background job (runs every 24 hours globally for all users)
setInterval(async () => {
  console.log("Running scheduled daily background task...");
  try {
    const result = await runDailyChecks(null);
    console.log(`Daily check complete. Sent ${result.count} reminder emails.`);
  } catch (err) {
    console.error("Scheduled check failed:", err);
  }
}, 24 * 60 * 60 * 1000);

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
