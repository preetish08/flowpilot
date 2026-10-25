const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const DB_FILE = path.join(__dirname, "flowpilot.db");

// Synchronous initialization helper
const db = new sqlite3.Database(DB_FILE);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

class Database {
  constructor() {
    this.init();
  }

  init() {
    db.serialize(() => {
      // Create Users table




      // Create Documents table
      db.run(`CREATE TABLE IF NOT EXISTS Documents (
        id TEXT PRIMARY KEY,
        userId INTEGER DEFAULT 1,
        fileName TEXT,
        fileSize INTEGER,
        mimeType TEXT,
        originalFile TEXT,
        extractedJson TEXT,
        documentType TEXT,
        confidence REAL,
        uploadedAt TEXT,
        status TEXT,
        summary TEXT,
        ocrVerification TEXT,
        recommendedRouting TEXT,
        invoiceData TEXT,
        contractData TEXT,
        resumeData TEXT,
        sopData TEXT,
        policyData TEXT,
        purchaseOrderData TEXT,
        bankStatementData TEXT,
        suggestedActions TEXT,
        keyDates TEXT,
        isDuplicate INTEGER DEFAULT 0,
        amountMismatch INTEGER DEFAULT 0,
        missingGst INTEGER DEFAULT 0,
        modelUsed TEXT,
        FOREIGN KEY(userId) REFERENCES Users(id)
      )`);

      // Create DocumentFields table
      db.run(`CREATE TABLE IF NOT EXISTS DocumentFields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documentId TEXT,
        fieldName TEXT,
        fieldValue TEXT,
        confidence REAL,
        FOREIGN KEY(documentId) REFERENCES Documents(id) ON DELETE CASCADE
      )`);

      // Create EmailLogs table
      db.run(`CREATE TABLE IF NOT EXISTS EmailLogs (
        id TEXT PRIMARY KEY,
        documentId TEXT,
        documentName TEXT,
        recipient TEXT,
        subject TEXT,
        body TEXT,
        sentAt TEXT,
        reminderType TEXT,
        scheduledDate TEXT,
        status TEXT,
        errorMessage TEXT,
        FOREIGN KEY(documentId) REFERENCES Documents(id) ON DELETE CASCADE
      )`);

      // Migration helper: safely adds a column to an existing table.
      // Ignores expected "duplicate column name" if already present, but logs unexpected errors.
      const safeAddColumn = (tableName, columnName, columnType) => {
        db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`, (err) => {
          if (err) {
            const msg = (err.message || "").toLowerCase();
            if (msg.includes("duplicate column name")) {
              return; // Expected: column already exists
            }
            console.error(`[SQLite Migration Error] Failed to add column "${columnName}" to table "${tableName}":`, err.message);
          }
        });
      };

      // Ensure new columns are present if the table was created under an older version
      safeAddColumn("Documents", "currency", "TEXT");
      safeAddColumn("EmailLogs", "reminderType", "TEXT");
      safeAddColumn("EmailLogs", "scheduledDate", "TEXT");
      safeAddColumn("EmailLogs", "status", "TEXT");
      safeAddColumn("EmailLogs", "errorMessage", "TEXT");

      // Backward-compatible migration: backfill currency for existing documents if missing
      db.all("SELECT id, invoiceData FROM Documents WHERE currency IS NULL AND invoiceData IS NOT NULL", (err, rows) => {
        if (err || !rows) return;
        for (const r of rows) {
          try {
            const inv = JSON.parse(r.invoiceData);
            const c = inv && inv.currency && (typeof inv.currency === 'object' ? inv.currency.value : inv.currency);
            if (c) {
              db.run("UPDATE Documents SET currency = ? WHERE id = ?", [c, r.id]);
            }
          } catch (_) {}
        }
      });

      // Create ReminderHistory table
      db.run(`CREATE TABLE IF NOT EXISTS ReminderHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        documentId TEXT,
        reminderType TEXT,
        sentAt TEXT,
        userId TEXT,
        scheduledDate TEXT,
        FOREIGN KEY(documentId) REFERENCES Documents(id) ON DELETE CASCADE
      )`);

      // Create Users table
      db.run(`CREATE TABLE IF NOT EXISTS Users (
        id TEXT PRIMARY KEY,
        fullName TEXT,
        companyName TEXT,
        email TEXT UNIQUE,
        passwordHash TEXT,
        createdAt TEXT
      )`);

      // Create Settings table
      db.run(`CREATE TABLE IF NOT EXISTS Settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )`);

      // Prepopulate default settings
      db.run(`INSERT OR IGNORE INTO Settings (key, value) VALUES ('threshold_USD', '5000')`);
      db.run(`INSERT OR IGNORE INTO Settings (key, value) VALUES ('threshold_EUR', '4500')`);
      db.run(`INSERT OR IGNORE INTO Settings (key, value) VALUES ('threshold_INR', '100000')`);

      // Ensure columns exist in respective tables for data isolation and idempotency
      safeAddColumn("Documents", "userId", "TEXT");
      safeAddColumn("Documents", "modelUsed", "TEXT");
      safeAddColumn("EmailLogs", "userId", "TEXT");
      safeAddColumn("ReminderHistory", "userId", "TEXT");
      safeAddColumn("ReminderHistory", "scheduledDate", "TEXT");
      safeAddColumn("Users", "fullName", "TEXT");
      safeAddColumn("Users", "companyName", "TEXT");
      safeAddColumn("Users", "passwordHash", "TEXT");
      safeAddColumn("Users", "resetTokenHash", "TEXT");
      safeAddColumn("Users", "resetTokenExpiry", "INTEGER");
    });
  }

  // Map database row back to structured UI-ready document object
  mapRowToDoc(row) {
    if (!row) return null;
    let invoiceData = null;
    if (row.invoiceData) {
      try {
        invoiceData = JSON.parse(row.invoiceData);
      } catch (e) {
        console.error("Failed to parse invoiceData:", e);
      }
    }
    // Fallback: If invoiceData is null or empty, but extractedJson exists
    if (!invoiceData && row.extractedJson) {
      try {
        const parsed = JSON.parse(row.extractedJson);
        if (parsed && typeof parsed === 'object') {
          if (parsed.invoiceData && typeof parsed.invoiceData === 'object') {
            invoiceData = parsed.invoiceData;
          } else if (parsed.invoice_number || parsed.invoiceNumber || parsed.totalAmount || parsed.from || parsed.bill_to) {
            invoiceData = parsed;
          }
        }
      } catch (_) {}
    }

    return {
      id: row.id,
      fileName: row.fileName,
      fileSize: row.fileSize,
      mimeType: row.mimeType,
      originalFile: row.originalFile || null,
      extractedJson: row.extractedJson ? (() => {
        try { return JSON.parse(row.extractedJson); } catch (_) { return null; }
      })() : null,
      uploadedAt: row.uploadedAt,
      status: row.status,
      isDuplicate: !!row.isDuplicate,
      amountMismatch: !!row.amountMismatch,
      missingGst: !!row.missingGst,
      documentType: row.documentType,
      confidence: row.confidence,
      summary: row.summary,
      ocrVerification: row.ocrVerification ? (() => {
        try { return JSON.parse(row.ocrVerification); } catch (_) { return null; }
      })() : null,
      recommendedRouting: row.recommendedRouting ? (() => {
        try { return JSON.parse(row.recommendedRouting); } catch (_) { return null; }
      })() : null,
      invoiceData,
      contractData: row.contractData ? (() => {
        try { return JSON.parse(row.contractData); } catch (_) { return null; }
      })() : null,
      resumeData: row.resumeData ? (() => {
        try { return JSON.parse(row.resumeData); } catch (_) { return null; }
      })() : null,
      sopData: row.sopData ? (() => {
        try { return JSON.parse(row.sopData); } catch (_) { return null; }
      })() : null,
      policyData: row.policyData ? (() => {
        try { return JSON.parse(row.policyData); } catch (_) { return null; }
      })() : null,
      purchaseOrderData: row.purchaseOrderData ? (() => {
        try { return JSON.parse(row.purchaseOrderData); } catch (_) { return null; }
      })() : null,
      bankStatementData: row.bankStatementData ? (() => {
        try { return JSON.parse(row.bankStatementData); } catch (_) { return null; }
      })() : null,
      suggestedActions: row.suggestedActions ? (() => {
        try { return JSON.parse(row.suggestedActions); } catch (_) { return []; }
      })() : [],
      keyDates: row.keyDates ? (() => {
        try { return JSON.parse(row.keyDates); } catch (_) { return []; }
      })() : [],
      userId: row.userId ? String(row.userId) : null,
      modelUsed: row.modelUsed || "gemini-3.8-flash",
      currency: row.currency || (invoiceData && invoiceData.currency && (typeof invoiceData.currency === 'object' ? invoiceData.currency.value : invoiceData.currency)) || null
    };
  }

  // Documents API
  async getDocuments(userId) {
    if (userId) {
      const rows = await dbAll("SELECT * FROM Documents WHERE userId = ? ORDER BY uploadedAt DESC", [String(userId)]);
      return rows.map(r => this.mapRowToDoc(r));
    }
    const rows = await dbAll("SELECT * FROM Documents ORDER BY uploadedAt DESC");
    return rows.map(r => this.mapRowToDoc(r));
  }

  async getDocument(id) {
    const row = await dbGet("SELECT * FROM Documents WHERE id = ?", [id]);
    return this.mapRowToDoc(row);
  }

  async addDocument(doc) {
    const docCurrency = doc.currency || (doc.invoiceData && doc.invoiceData.currency && (typeof doc.invoiceData.currency === 'object' ? doc.invoiceData.currency.value : doc.invoiceData.currency)) || null;

    await dbRun(`INSERT INTO Documents (
      id, fileName, fileSize, mimeType, originalFile, extractedJson,
      documentType, confidence, uploadedAt, status, summary,
      ocrVerification, recommendedRouting, invoiceData, contractData,
      resumeData, sopData, policyData, purchaseOrderData, bankStatementData,
      suggestedActions, keyDates, isDuplicate, amountMismatch, missingGst, userId, modelUsed, currency
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      doc.id,
      doc.fileName,
      doc.fileSize,
      doc.mimeType,
      doc.originalFile || null,
      doc.extractedJson || null,
      doc.documentType,
      doc.confidence,
      doc.uploadedAt,
      doc.status,
      doc.summary,
      doc.ocrVerification ? JSON.stringify(doc.ocrVerification) : null,
      doc.recommendedRouting ? JSON.stringify(doc.recommendedRouting) : null,
      doc.invoiceData ? JSON.stringify(doc.invoiceData) : null,
      doc.contractData ? JSON.stringify(doc.contractData) : null,
      doc.resumeData ? JSON.stringify(doc.resumeData) : null,
      doc.sopData ? JSON.stringify(doc.sopData) : null,
      doc.policyData ? JSON.stringify(doc.policyData) : null,
      doc.purchaseOrderData ? JSON.stringify(doc.purchaseOrderData) : null,
      doc.bankStatementData ? JSON.stringify(doc.bankStatementData) : null,
      doc.suggestedActions ? JSON.stringify(doc.suggestedActions) : null,
      doc.keyDates ? JSON.stringify(doc.keyDates) : null,
      doc.isDuplicate ? 1 : 0,
      doc.amountMismatch ? 1 : 0,
      doc.missingGst ? 1 : 0,
      doc.userId || null,
      doc.modelUsed || "gemini-3.8-flash",
      docCurrency
    ]);

    // Relational Extraction: Populate DocumentFields
    const dataObj = doc.invoiceData || doc.contractData || doc.resumeData || doc.sopData || doc.policyData || doc.purchaseOrderData || doc.bankStatementData;
    if (dataObj) {
      for (const [key, field] of Object.entries(dataObj)) {
        if (field && typeof field === "object" && "value" in field) {
          const valStr = typeof field.value === "object" ? JSON.stringify(field.value) : String(field.value);
          await dbRun("INSERT INTO DocumentFields (documentId, fieldName, fieldValue, confidence) VALUES (?, ?, ?, ?)", [
            doc.id,
            key,
            valStr,
            field.confidence || doc.confidence
          ]);
        }
      }
    }

    return doc;
  }

  async updateDocument(id, updatedFields) {
    const existing = await this.getDocument(id);
    if (!existing) return null;

    const merged = { ...existing, ...updatedFields };
    const docCurrency = merged.currency || (merged.invoiceData && merged.invoiceData.currency && (typeof merged.invoiceData.currency === 'object' ? merged.invoiceData.currency.value : merged.invoiceData.currency)) || null;

    await dbRun(`UPDATE Documents SET
      status = ?,
      isDuplicate = ?,
      amountMismatch = ?,
      missingGst = ?,
      suggestedActions = ?,
      keyDates = ?,
      summary = ?,
      invoiceData = ?,
      contractData = ?,
      resumeData = ?,
      sopData = ?,
      policyData = ?,
      purchaseOrderData = ?,
      bankStatementData = ?,
      documentType = ?,
      confidence = ?,
      modelUsed = ?,
      extractedJson = ?,
      currency = ?
      WHERE id = ?`, [
      merged.status,
      merged.isDuplicate ? 1 : 0,
      merged.amountMismatch ? 1 : 0,
      merged.missingGst ? 1 : 0,
      JSON.stringify(merged.suggestedActions),
      JSON.stringify(merged.keyDates),
      merged.summary,
      merged.invoiceData ? JSON.stringify(merged.invoiceData) : null,
      merged.contractData ? JSON.stringify(merged.contractData) : null,
      merged.resumeData ? JSON.stringify(merged.resumeData) : null,
      merged.sopData ? JSON.stringify(merged.sopData) : null,
      merged.policyData ? JSON.stringify(merged.policyData) : null,
      merged.purchaseOrderData ? JSON.stringify(merged.purchaseOrderData) : null,
      merged.bankStatementData ? JSON.stringify(merged.bankStatementData) : null,
      merged.documentType,
      merged.confidence,
      merged.modelUsed || "gemini-3.8-flash",
      merged.extractedJson ? (typeof merged.extractedJson === 'string' ? merged.extractedJson : JSON.stringify(merged.extractedJson)) : null,
      docCurrency,
      id
    ]);

    return merged;
  }

  async deleteDocument(id) {
    const res = await dbRun("DELETE FROM Documents WHERE id = ?", [id]);
    return res.changes > 0;
  }

  // Email Logs API
  async getEmailLogs(userId) {
    if (userId) {
      return await dbAll("SELECT * FROM EmailLogs WHERE userId = ? ORDER BY sentAt DESC", [String(userId)]);
    }
    return await dbAll("SELECT * FROM EmailLogs ORDER BY sentAt DESC");
  }

  async addEmailLog(log) {
    await dbRun(`INSERT INTO EmailLogs (
      id, documentId, documentName, recipient, subject, body, sentAt,
      reminderType, scheduledDate, status, errorMessage, userId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      log.id,
      log.documentId,
      log.documentName,
      log.recipient,
      log.subject,
      log.body,
      log.sentAt,
      log.reminderType || null,
      log.scheduledDate || null,
      log.status || "Sent",
      log.errorMessage || null,
      log.userId ? String(log.userId) : null
    ]);
    return log;
  }

  // Sent Reminders Registry / ReminderHistory table API
  async hasReminderBeenSent(docId, type, scheduledDate = null) {
    if (scheduledDate) {
      const row = await dbGet("SELECT id FROM ReminderHistory WHERE documentId = ? AND reminderType = ? AND scheduledDate = ?", [docId, type, scheduledDate]);
      return !!row;
    }
    const row = await dbGet("SELECT id FROM ReminderHistory WHERE documentId = ? AND reminderType = ?", [docId, type]);
    return !!row;
  }

  async markReminderAsSent(docId, type, scheduledDate = null, userId = null) {
    await dbRun("INSERT INTO ReminderHistory (documentId, reminderType, sentAt, scheduledDate, userId) VALUES (?, ?, ?, ?, ?)", [
      docId,
      type,
      new Date().toISOString(),
      scheduledDate,
      userId ? String(userId) : null
    ]);
  }

  // Settings API
  async getSettings() {
    const rows = await dbAll("SELECT * FROM Settings");
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });
    return settings;
  }

  async updateSettings(settingsObj) {
    for (const [key, value] of Object.entries(settingsObj)) {
      await dbRun("INSERT OR REPLACE INTO Settings (key, value) VALUES (?, ?)", [key, String(value)]);
    }
    return settingsObj;
  }

  // User Management API
  async addUser(user) {
    const result = await dbRun("INSERT INTO Users (fullName, companyName, email, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)", [
      user.fullName,
      user.companyName,
      user.email,
      user.passwordHash,
      new Date().toISOString()
    ]);
    user.id = result.lastID;
    return user;
  }
  async updateUserPassword(userId, passwordHash) {
    await dbRun(
      "UPDATE Users SET passwordHash = ? WHERE id = ?",
      [passwordHash, userId]
    );
    return true;
  }
  async getUserByEmail(email) {
    return await dbGet("SELECT * FROM Users WHERE email = ?", [email]);
  }

  async getUserById(id) {
    const numericId = parseInt(id, 10);
    if (!isNaN(numericId)) {
      return await dbGet("SELECT * FROM Users WHERE id = ?", [numericId]);
    }
    return await dbGet("SELECT * FROM Users WHERE id = ?", [id]);
  }

  async updateUserResetToken(email, hashedToken, expiryTime) {
    await dbRun(
      "UPDATE Users SET resetTokenHash = ?, resetTokenExpiry = ? WHERE email = ?",
      [hashedToken, expiryTime, email]
    );
  }

  async updateUserPasswordAndClearToken(email, newPasswordHash) {
    await dbRun(
      "UPDATE Users SET passwordHash = ?, resetTokenHash = NULL, resetTokenExpiry = NULL WHERE email = ?",
      [newPasswordHash, email]
    );
  }
}

module.exports = new Database();
