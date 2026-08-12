const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const DB_FILE = path.join(__dirname, "flowpilot.db");

// Synchronous initialization helper
const db = new sqlite3.Database(DB_FILE);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
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
      db.run(`CREATE TABLE IF NOT EXISTS Users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        role TEXT,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP
      )`);

      // Prepopulate default user
      db.run(`INSERT OR IGNORE INTO Users (id, name, email, role) VALUES (1, 'Admin User', 'admin@flowpilot.io', 'administrator')`);

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

      // Ensure new columns are present if the table was created under an older version
      db.run(`ALTER TABLE EmailLogs ADD COLUMN reminderType TEXT`, () => {});
      db.run(`ALTER TABLE EmailLogs ADD COLUMN scheduledDate TEXT`, () => {});
      db.run(`ALTER TABLE EmailLogs ADD COLUMN status TEXT`, () => {});
      db.run(`ALTER TABLE EmailLogs ADD COLUMN errorMessage TEXT`, () => {});

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
      db.run(`ALTER TABLE Documents ADD COLUMN userId TEXT`, () => {});
      db.run(`ALTER TABLE EmailLogs ADD COLUMN userId TEXT`, () => {});
      db.run(`ALTER TABLE ReminderHistory ADD COLUMN userId TEXT`, () => {});
      db.run(`ALTER TABLE ReminderHistory ADD COLUMN scheduledDate TEXT`, () => {});
      db.run(`ALTER TABLE Users ADD COLUMN fullName TEXT`, () => {});
      db.run(`ALTER TABLE Users ADD COLUMN companyName TEXT`, () => {});
      db.run(`ALTER TABLE Users ADD COLUMN passwordHash TEXT`, () => {});
    });
  }

  // Map database row back to structured UI-ready document object
  mapRowToDoc(row) {
    if (!row) return null;
    return {
      id: row.id,
      fileName: row.fileName,
      fileSize: row.fileSize,
      mimeType: row.mimeType,
      uploadedAt: row.uploadedAt,
      status: row.status,
      isDuplicate: !!row.isDuplicate,
      amountMismatch: !!row.amountMismatch,
      missingGst: !!row.missingGst,
      documentType: row.documentType,
      confidence: row.confidence,
      summary: row.summary,
      ocrVerification: row.ocrVerification ? JSON.parse(row.ocrVerification) : null,
      recommendedRouting: row.recommendedRouting ? JSON.parse(row.recommendedRouting) : null,
      invoiceData: row.invoiceData ? JSON.parse(row.invoiceData) : null,
      contractData: row.contractData ? JSON.parse(row.contractData) : null,
      resumeData: row.resumeData ? JSON.parse(row.resumeData) : null,
      sopData: row.sopData ? JSON.parse(row.sopData) : null,
      policyData: row.policyData ? JSON.parse(row.policyData) : null,
      purchaseOrderData: row.purchaseOrderData ? JSON.parse(row.purchaseOrderData) : null,
      bankStatementData: row.bankStatementData ? JSON.parse(row.bankStatementData) : null,
      suggestedActions: row.suggestedActions ? JSON.parse(row.suggestedActions) : [],
      keyDates: row.keyDates ? JSON.parse(row.keyDates) : [],
      userId: row.userId ? String(row.userId) : null
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
    await dbRun(`INSERT INTO Documents (
      id, fileName, fileSize, mimeType, originalFile, extractedJson,
      documentType, confidence, uploadedAt, status, summary,
      ocrVerification, recommendedRouting, invoiceData, contractData,
      resumeData, sopData, policyData, purchaseOrderData, bankStatementData,
      suggestedActions, keyDates, isDuplicate, amountMismatch, missingGst, userId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
      doc.userId || null
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

    await dbRun(`UPDATE Documents SET
      status = ?,
      isDuplicate = ?,
      amountMismatch = ?,
      missingGst = ?,
      suggestedActions = ?,
      keyDates = ?
      WHERE id = ?`, [
        merged.status,
        merged.isDuplicate ? 1 : 0,
        merged.amountMismatch ? 1 : 0,
        merged.missingGst ? 1 : 0,
        JSON.stringify(merged.suggestedActions),
        JSON.stringify(merged.keyDates),
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
}

module.exports = new Database();
