const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Database file location. Defaults to the bundled development database.
// If DATABASE_PATH is set in the environment, that path is used instead —
// this is the isolation seam that lets automated tests run against throwaway
// databases without ever touching the production/development database.
// When DATABASE_PATH is unset, behaviour is identical to before.
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'traintrack.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let _db = null;

function initDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA foreign_keys = ON');
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
        db.exec(schema, (err2) => {
          if (err2) return reject(err2);
          // Migrations for existing databases (ignore "duplicate column" errors)
          const migrations = [
            "ALTER TABLE tblStaff ADD COLUMN Gender TEXT",
            "ALTER TABLE tblRegister ADD COLUMN SignBy TEXT",
            "ALTER TABLE tblRegister ADD COLUMN SignDate TEXT",
            "ALTER TABLE tblClass ADD COLUMN TrainerID INTEGER",
            "ALTER TABLE tblClass ADD COLUMN MaxSeats INTEGER",
            "ALTER TABLE tblRegister ADD COLUMN BookedDate TEXT",
            "ALTER TABLE tblRegister ADD COLUMN CheckedInAt TEXT",
            "ALTER TABLE tblEmpJob ADD COLUMN IsPrimary INTEGER DEFAULT 0",
            "ALTER TABLE tblEmpJob ADD COLUMN DateAssigned TEXT",
            "ALTER TABLE tblFormTemplate ADD COLUMN Locked INTEGER DEFAULT 0",
            "ALTER TABLE tblFormTemplate ADD COLUMN TransLang TEXT",
            "ALTER TABLE tblFormTemplate ADD COLUMN TransLayout TEXT",
            "ALTER TABLE tblFormTemplate ADD COLUMN TransSideOrder TEXT",
            "ALTER TABLE tblFormTemplate ADD COLUMN TransName TEXT",
            "ALTER TABLE tblFormTemplate ADD COLUMN TransDescription TEXT",
            "ALTER TABLE tblFormField ADD COLUMN Translation TEXT",
            "ALTER TABLE tblFormSubmission ADD COLUMN SupervisorSignature TEXT",
            "ALTER TABLE tblFormSubmission ADD COLUMN SupervisorSignedAt TEXT",
            "ALTER TABLE tblFormSubmission ADD COLUMN SupervisorName TEXT",
            "ALTER TABLE tblCerts ADD COLUMN ParentCertID INTEGER",
            "ALTER TABLE tblQ ADD COLUMN QuestionType TEXT DEFAULT 'multi'",
            "ALTER TABLE tblQ ADD COLUMN VideoUrl TEXT",
            "ALTER TABLE tblQ ADD COLUMN BankTag TEXT",
            "ALTER TABLE tblQ ADD COLUMN InfoText TEXT",
            "ALTER TABLE tblQ ADD COLUMN Mandatory INTEGER DEFAULT 0",
            "ALTER TABLE tblQA ADD COLUMN IsCorrect INTEGER DEFAULT 0",
            "ALTER TABLE tblTest ADD COLUMN Randomize INTEGER DEFAULT 1",
            "ALTER TABLE tblTest ADD COLUMN QPerExam INTEGER",
            "ALTER TABLE tblTest ADD COLUMN ShowAnswers INTEGER DEFAULT 1",
            "ALTER TABLE tblTest ADD COLUMN Locked INTEGER DEFAULT 0",
            "ALTER TABLE tblPswd ADD COLUMN PageAccess TEXT",
            "ALTER TABLE tblFiles ADD COLUMN Approved INTEGER DEFAULT 1",
            "ALTER TABLE tblFiles ADD COLUMN ApprovedBy TEXT",
            "ALTER TABLE tblFiles ADD COLUMN ApprovedDate TEXT",
            "ALTER TABLE tblFiles ADD COLUMN SourceFileID INTEGER",
            "ALTER TABLE tblFiles ADD COLUMN TargetLang TEXT",
            "ALTER TABLE tblRegister ADD COLUMN NotifiedExpiring TEXT",
            "ALTER TABLE tblRegister ADD COLUMN NotifiedExpired TEXT",
            `CREATE TABLE IF NOT EXISTS tblExamWrongQ (
              WrongID INTEGER PRIMARY KEY AUTOINCREMENT,
              EmpID INTEGER NOT NULL, TestID INTEGER NOT NULL, QID INTEGER NOT NULL,
              WrongCount INTEGER DEFAULT 1, LastWrong TEXT DEFAULT (date('now')),
              UNIQUE(EmpID, TestID, QID)
            )`,
            `CREATE TABLE IF NOT EXISTS tblTransMemory (
              TMID INTEGER PRIMARY KEY AUTOINCREMENT,
              LangCode TEXT NOT NULL,
              SourceText TEXT NOT NULL,
              TargetText TEXT NOT NULL,
              Approved INTEGER DEFAULT 0,
              JobFileID INTEGER,
              UseCount INTEGER DEFAULT 0,
              CreatedBy TEXT,
              CreatedDate TEXT DEFAULT (datetime('now')),
              UNIQUE(LangCode, SourceText)
            )`,
            `CREATE TABLE IF NOT EXISTS tblTransSegment (
              SegID INTEGER PRIMARY KEY AUTOINCREMENT,
              JobFileID INTEGER NOT NULL,
              OrderNum INTEGER,
              SourceText TEXT,
              TargetText TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS tblTerminology (
              TermID INTEGER PRIMARY KEY AUTOINCREMENT,
              LangCode TEXT NOT NULL,
              SourceTerm TEXT NOT NULL,
              TargetTerm TEXT NOT NULL,
              Note TEXT,
              CreatedBy TEXT,
              CreatedDate TEXT DEFAULT (datetime('now')),
              UNIQUE(LangCode, SourceTerm)
            )`,
            `CREATE TABLE IF NOT EXISTS tblWorkflow (
              WorkflowID INTEGER PRIMARY KEY AUTOINCREMENT,
              Name TEXT NOT NULL,
              TriggerEvent TEXT NOT NULL,
              Recipients TEXT, CcRecipients TEXT,
              NotifySupervisor INTEGER DEFAULT 0,
              NotifyEmployee INTEGER DEFAULT 0,
              SubjectTemplate TEXT,
              Note TEXT,
              Active INTEGER DEFAULT 1,
              DateCreated TEXT DEFAULT (date('now')),
              CreatedBy TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS tblShiftType (
              ShiftTypeID INTEGER PRIMARY KEY AUTOINCREMENT,
              Label TEXT NOT NULL, Color TEXT DEFAULT '#F58220',
              StartTime TEXT, EndTime TEXT, SortOrder INTEGER DEFAULT 0,
              IsOff INTEGER DEFAULT 0
            )`,
            // Competency Management
            `CREATE TABLE IF NOT EXISTS tblCompetencyFramework (
              FrameworkID INTEGER PRIMARY KEY AUTOINCREMENT,
              Name TEXT NOT NULL,
              Description TEXT,
              Status TEXT DEFAULT 'Active',
              CreatedBy TEXT,
              CreatedAt TEXT DEFAULT (datetime('now'))
            )`,
            `CREATE TABLE IF NOT EXISTS tblCompetency (
              CompetencyID INTEGER PRIMARY KEY AUTOINCREMENT,
              FrameworkID INTEGER,
              Name TEXT NOT NULL,
              Description TEXT,
              Category TEXT,
              Status TEXT DEFAULT 'Active',
              CreatedBy TEXT,
              CreatedAt TEXT DEFAULT (datetime('now'))
            )`,
            `CREATE TABLE IF NOT EXISTS tblCompetencyReq (
              ReqID INTEGER PRIMARY KEY AUTOINCREMENT,
              CompetencyID INTEGER NOT NULL,
              JobID INTEGER,
              DeptID INTEGER,
              CreatedBy TEXT,
              CreatedAt TEXT DEFAULT (datetime('now')),
              UNIQUE(CompetencyID, JobID, DeptID)
            )`,
            `CREATE TABLE IF NOT EXISTS tblCompetencyRecord (
              RecordID INTEGER PRIMARY KEY AUTOINCREMENT,
              EmpID INTEGER NOT NULL,
              CompetencyID INTEGER NOT NULL,
              Status TEXT DEFAULT 'Not Yet',
              AssessedDate TEXT,
              AssessedBy TEXT,
              FormSubmissionID INTEGER,
              Notes TEXT,
              CreatedAt TEXT DEFAULT (datetime('now'))
            )`,
            // Knowledge Base
            `CREATE TABLE IF NOT EXISTS tblKBCategory (
              CategoryID INTEGER PRIMARY KEY AUTOINCREMENT,
              Name TEXT NOT NULL,
              Color TEXT DEFAULT '#4f46e5',
              Icon TEXT DEFAULT '📄',
              SortOrder INTEGER DEFAULT 0
            )`,
            `CREATE TABLE IF NOT EXISTS tblKBArticle (
              ArticleID INTEGER PRIMARY KEY AUTOINCREMENT,
              CategoryID INTEGER,
              Title TEXT NOT NULL,
              Body TEXT,
              Tags TEXT,
              Status TEXT DEFAULT 'Draft',
              ViewCount INTEGER DEFAULT 0,
              AuthoredBy TEXT,
              CreatedAt TEXT DEFAULT (datetime('now')),
              UpdatedAt TEXT DEFAULT (datetime('now')),
              UpdatedBy TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS tblKBRating (
              RatingID INTEGER PRIMARY KEY AUTOINCREMENT,
              ArticleID INTEGER NOT NULL,
              UserName TEXT NOT NULL,
              Helpful INTEGER DEFAULT 1,
              RatedAt TEXT DEFAULT (datetime('now')),
              UNIQUE(ArticleID, UserName)
            )`,
            // Competency level scale
            "ALTER TABLE tblCompetencyReq ADD COLUMN RequiredLevel INTEGER DEFAULT 3",
            "ALTER TABLE tblCompetencyRecord ADD COLUMN AchievedLevel INTEGER",
            "ALTER TABLE tblFiles ADD COLUMN StructuredData TEXT",
            // Destination folder for AI Content Studio docs: 'library' | 'training-standards' | 'training-material'
            "ALTER TABLE tblFiles ADD COLUMN Folder TEXT",
            // Training Material category folders (e.g. Haul Truck Training Material, CAT777, CAT745)
            `CREATE TABLE IF NOT EXISTS tblTrainMatCat (
              CatID INTEGER PRIMARY KEY AUTOINCREMENT,
              Name TEXT NOT NULL UNIQUE,
              SortOrder INTEGER DEFAULT 0,
              CreatedBy TEXT,
              CreatedDate TEXT DEFAULT (datetime('now'))
            )`,
            // ── Employee Onboarding ─────────────────────────────────────────
            // One row per candidate going through pre-hire process. Promoted to tblStaff on completion.
            `CREATE TABLE IF NOT EXISTS tblOnboarding (
              CandidateID INTEGER PRIMARY KEY AUTOINCREMENT,
              FirstName TEXT NOT NULL,
              LastName TEXT NOT NULL,
              Email TEXT,
              Phone TEXT,
              DOB TEXT,
              Gender TEXT,
              Address TEXT,
              EmergencyContact TEXT,
              EmergencyPhone TEXT,
              Position TEXT,
              DeptID INTEGER,
              JobID INTEGER,
              StartDate TEXT,
              Status TEXT DEFAULT 'New',
              Notes TEXT,
              PromotedStaffID INTEGER,
              CreatedBy TEXT,
              CreatedAt TEXT DEFAULT (datetime('now')),
              UpdatedAt TEXT DEFAULT (datetime('now'))
            )`,
            // Documents attached to a candidate (CV, contract, role description, medical, etc.)
            // DocType: 'cv' | 'contract' | 'role-description' | 'medical' | 'id' | 'other'
            `CREATE TABLE IF NOT EXISTS tblOnboardingDoc (
              DocID INTEGER PRIMARY KEY AUTOINCREMENT,
              CandidateID INTEGER NOT NULL,
              DocType TEXT NOT NULL,
              FileName TEXT NOT NULL,
              StoredName TEXT NOT NULL,
              MimeType TEXT,
              FileSize INTEGER,
              Notes TEXT,
              UploadedBy TEXT,
              UploadedAt TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (CandidateID) REFERENCES tblOnboarding(CandidateID) ON DELETE CASCADE
            )`,
            // CV reviews — one row per reviewer (Superintendent, Manager, Supervisor)
            // Decision: 'Approved' | 'Rejected' | 'Pending'
            `CREATE TABLE IF NOT EXISTS tblOnboardingReview (
              ReviewID INTEGER PRIMARY KEY AUTOINCREMENT,
              CandidateID INTEGER NOT NULL,
              ReviewerRole TEXT NOT NULL,
              ReviewerName TEXT,
              Decision TEXT DEFAULT 'Pending',
              Comments TEXT,
              ReviewedAt TEXT,
              CreatedAt TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (CandidateID) REFERENCES tblOnboarding(CandidateID) ON DELETE CASCADE
            )`,
            // ── HR Disciplinary Actions ────────────────────────────────────
            // Tracks warnings / performance issues / over-entitlement actions per employee.
            // Optional FormTemplateID + FormSubmissionID let HR attach a structured form record.
            `CREATE TABLE IF NOT EXISTS tblDisciplinary (
              ActionID INTEGER PRIMARY KEY AUTOINCREMENT,
              EmpID INTEGER NOT NULL,
              ActionType TEXT NOT NULL DEFAULT 'Verbal Warning',
              Severity TEXT DEFAULT 'Minor',
              Reason TEXT NOT NULL,
              Description TEXT,
              IssuedDate TEXT DEFAULT (date('now')),
              IssuedBy TEXT,
              FollowUpDate TEXT,
              Status TEXT DEFAULT 'Open',
              Resolution TEXT,
              FormTemplateID INTEGER,
              FormSubmissionID INTEGER,
              AutoGenerated INTEGER DEFAULT 0,
              Notes TEXT,
              CreatedAt TEXT DEFAULT (datetime('now'))
            )`,
            // Documents attached to a disciplinary action (warning letter PDF, photos, etc.)
            `CREATE TABLE IF NOT EXISTS tblDisciplinaryDoc (
              DocID INTEGER PRIMARY KEY AUTOINCREMENT,
              ActionID INTEGER NOT NULL,
              FileName TEXT NOT NULL,
              StoredName TEXT NOT NULL,
              MimeType TEXT,
              FileSize INTEGER,
              Notes TEXT,
              UploadedBy TEXT,
              UploadedAt TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (ActionID) REFERENCES tblDisciplinary(ActionID) ON DELETE CASCADE
            )`,
            // Distinguish HR forms from Assessment forms so the same Form Builder pipeline can serve both.
            // 'assessment' (default — backward-compat) vs 'hr'.
            "ALTER TABLE tblFormTemplate ADD COLUMN FormCategory TEXT DEFAULT 'assessment'",
            // ── Employee Assignment ────────────────────────────────────────
            // Daily assignment of an employee to either a piece of equipment OR a generic duty
            // (job title / location / department / free-text task). Multiple rows per employee/day allowed.
            `CREATE TABLE IF NOT EXISTS tblAssignment (
              AssignmentID INTEGER PRIMARY KEY AUTOINCREMENT,
              EmpID INTEGER NOT NULL,
              AssignDate TEXT NOT NULL,
              AssignmentType TEXT NOT NULL DEFAULT 'equipment',
              EquipmentID INTEGER,
              JobID INTEGER,
              LocID INTEGER,
              DeptID INTEGER,
              ShiftLabel TEXT,
              TaskDescription TEXT,
              StartTime TEXT,
              EndTime TEXT,
              Status TEXT DEFAULT 'Active',
              Notes TEXT,
              AssignedBy TEXT,
              AssignedAt TEXT DEFAULT (datetime('now')),
              UpdatedAt TEXT DEFAULT (datetime('now'))
            )`,
            // ── Mobile Equipment ───────────────────────────────────────────
            // Equipment type catalog (Cat 745C, Komatsu PC2000, etc.)
            `CREATE TABLE IF NOT EXISTS tblEquipmentType (
              EquipTypeID INTEGER PRIMARY KEY AUTOINCREMENT,
              Name TEXT NOT NULL UNIQUE,
              Category TEXT,
              Manufacturer TEXT,
              ModelNumber TEXT,
              ServiceIntervalHours INTEGER DEFAULT 250,
              Color TEXT DEFAULT '#1E3A5F',
              Description TEXT,
              Active INTEGER DEFAULT 1,
              CreatedAt TEXT DEFAULT (datetime('now'))
            )`,
            // Individual equipment units (HT-001, EX-014, etc.)
            `CREATE TABLE IF NOT EXISTS tblEquipment (
              EquipmentID INTEGER PRIMARY KEY AUTOINCREMENT,
              AssetNumber TEXT NOT NULL UNIQUE,
              EquipTypeID INTEGER,
              SerialNumber TEXT,
              YearOfManufacture INTEGER,
              PurchaseDate TEXT,
              Location TEXT,
              CurrentHours INTEGER DEFAULT 0,
              Status TEXT DEFAULT 'Active',
              Notes TEXT,
              CreatedBy TEXT,
              CreatedAt TEXT DEFAULT (datetime('now')),
              UpdatedAt TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (EquipTypeID) REFERENCES tblEquipmentType(EquipTypeID)
            )`,
            // Scheduled / completed services (preventive maintenance)
            `CREATE TABLE IF NOT EXISTS tblEquipmentService (
              ServiceID INTEGER PRIMARY KEY AUTOINCREMENT,
              EquipmentID INTEGER NOT NULL,
              ServiceType TEXT NOT NULL,
              ScheduledDate TEXT,
              CompletedDate TEXT,
              ScheduledHours INTEGER,
              CompletedHours INTEGER,
              Performer TEXT,
              Cost REAL DEFAULT 0,
              Status TEXT DEFAULT 'Scheduled',
              Notes TEXT,
              CreatedBy TEXT,
              CreatedAt TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (EquipmentID) REFERENCES tblEquipment(EquipmentID) ON DELETE CASCADE
            )`,
            // Breakdown / fault records
            `CREATE TABLE IF NOT EXISTS tblEquipmentBreakdown (
              BreakdownID INTEGER PRIMARY KEY AUTOINCREMENT,
              EquipmentID INTEGER NOT NULL,
              BreakdownDate TEXT NOT NULL,
              ReportedBy TEXT,
              Severity TEXT DEFAULT 'Minor',
              Description TEXT NOT NULL,
              RootCause TEXT,
              ResolvedDate TEXT,
              DowntimeHours REAL DEFAULT 0,
              Status TEXT DEFAULT 'Open',
              Cost REAL DEFAULT 0,
              Notes TEXT,
              CreatedAt TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (EquipmentID) REFERENCES tblEquipment(EquipmentID) ON DELETE CASCADE
            )`,
            // ── Leave Types & Bookings ─────────────────────────────────────
            // Catalog of leave categories (Annual, Sick, Personal, Bereavement, Unpaid, etc.)
            `CREATE TABLE IF NOT EXISTS tblLeaveType (
              LeaveTypeID INTEGER PRIMARY KEY AUTOINCREMENT,
              Name TEXT NOT NULL UNIQUE,
              Color TEXT DEFAULT '#3b82f6',
              Paid INTEGER DEFAULT 1,
              DefaultDays INTEGER DEFAULT 0,
              Description TEXT,
              Active INTEGER DEFAULT 1,
              CreatedAt TEXT DEFAULT (datetime('now'))
            )`,
            // A booked leave period for an employee (Pending → Approved/Rejected → Cancelled)
            `CREATE TABLE IF NOT EXISTS tblLeaveBooking (
              BookingID INTEGER PRIMARY KEY AUTOINCREMENT,
              EmpID INTEGER NOT NULL,
              LeaveTypeID INTEGER NOT NULL,
              StartDate TEXT NOT NULL,
              EndDate TEXT NOT NULL,
              Days REAL DEFAULT 0,
              Reason TEXT,
              Status TEXT DEFAULT 'Pending',
              RequestedBy TEXT,
              RequestedAt TEXT DEFAULT (datetime('now')),
              ApprovedBy TEXT,
              ApprovedAt TEXT,
              Notes TEXT,
              FOREIGN KEY (LeaveTypeID) REFERENCES tblLeaveType(LeaveTypeID)
            )`,
            // ── Daily attendance record (one row per employee per day) ─────
            // Status values: Present, Absent, Late, Leave, No Show, Excused
            `CREATE TABLE IF NOT EXISTS tblAttendance (
              AttendanceID INTEGER PRIMARY KEY AUTOINCREMENT,
              EmpID INTEGER NOT NULL,
              AttDate TEXT NOT NULL,
              Status TEXT NOT NULL DEFAULT 'Present',
              LeaveBookingID INTEGER,
              ShiftLabel TEXT,
              TimeIn TEXT,
              TimeOut TEXT,
              Notes TEXT,
              MarkedBy TEXT,
              MarkedAt TEXT DEFAULT (datetime('now')),
              UNIQUE(EmpID, AttDate)
            )`,
            // Pre-employment medical record
            `CREATE TABLE IF NOT EXISTS tblOnboardingMedical (
              MedicalID INTEGER PRIMARY KEY AUTOINCREMENT,
              CandidateID INTEGER NOT NULL,
              Provider TEXT,
              AppointmentDate TEXT,
              CompletedDate TEXT,
              Result TEXT,
              FitForWork INTEGER DEFAULT 0,
              Restrictions TEXT,
              Notes TEXT,
              CreatedBy TEXT,
              CreatedAt TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (CandidateID) REFERENCES tblOnboarding(CandidateID) ON DELETE CASCADE
            )`,

            // ─────────────────────────────────────────────────────────────────
            // WP-18 · E2 — Enterprise Document Engine database foundation.
            // Additive, idempotent (CREATE ... IF NOT EXISTS). Foreign keys ONLY
            // between the new tblDocument* tables — NO legacy table is altered or
            // connected. Nothing consumes these tables yet (fully unwired).
            // ─────────────────────────────────────────────────────────────────
            `CREATE TABLE IF NOT EXISTS tblDocument (
              DocumentID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentNumber TEXT UNIQUE,
              Title TEXT,
              Description TEXT,
              DocumentType TEXT,
              DocumentStatus TEXT,
              WorkflowID TEXT,
              VersionScheme TEXT,
              VersionMajor INTEGER DEFAULT 0,
              VersionMinor INTEGER DEFAULT 0,
              VersionPatch INTEGER DEFAULT 0,
              Revision TEXT,
              Classification TEXT,
              ComplianceFramework TEXT,
              Owner TEXT,
              Author TEXT,
              Department TEXT,
              Site TEXT,
              EffectiveDate TEXT,
              ReviewDate TEXT,
              ExpiryDate TEXT,
              CreatedBy TEXT,
              CreatedDate TEXT DEFAULT (datetime('now')),
              UpdatedBy TEXT,
              UpdatedDate TEXT,
              IsDeleted INTEGER DEFAULT 0
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentVersion (
              VersionID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentID INTEGER NOT NULL,
              VersionString TEXT,
              StoredName TEXT,
              OriginalName TEXT,
              MimeType TEXT,
              FileSize INTEGER,
              Checksum TEXT,
              CreatedBy TEXT,
              CreatedDate TEXT DEFAULT (datetime('now')),
              Status TEXT,
              FOREIGN KEY (DocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentMetadata (
              MetadataID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentID INTEGER NOT NULL,
              FieldID TEXT,
              FieldValue TEXT,
              FOREIGN KEY (DocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentRelationship (
              RelationshipID INTEGER PRIMARY KEY AUTOINCREMENT,
              FromDocumentID INTEGER NOT NULL,
              RelationshipType TEXT,
              ToDocumentID INTEGER NOT NULL,
              CreatedBy TEXT,
              CreatedDate TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (FromDocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE,
              FOREIGN KEY (ToDocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentApproval (
              ApprovalID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentID INTEGER NOT NULL,
              WorkflowStep TEXT,
              ApprovalLevel TEXT,
              Approver TEXT,
              Decision TEXT,
              Comments TEXT,
              DecisionDate TEXT,
              FOREIGN KEY (DocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentAcknowledgement (
              AcknowledgementID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentID INTEGER NOT NULL,
              Username TEXT,
              AcknowledgedDate TEXT,
              FOREIGN KEY (DocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentDistribution (
              DistributionID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentID INTEGER NOT NULL,
              DistributionType TEXT,
              Target TEXT,
              CreatedDate TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (DocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentAccess (
              AccessID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentID INTEGER NOT NULL,
              AccessMode TEXT,
              Principal TEXT,
              CreatedDate TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (DocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentNotification (
              NotificationID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentID INTEGER NOT NULL,
              NotificationType TEXT,
              Recipient TEXT,
              Status TEXT,
              CreatedDate TEXT DEFAULT (datetime('now')),
              FOREIGN KEY (DocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentSearchIndex (
              IndexID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentID INTEGER NOT NULL,
              IndexedText TEXT,
              IndexedDate TEXT,
              FOREIGN KEY (DocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentCompliance (
              ComplianceID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentID INTEGER NOT NULL,
              Framework TEXT,
              LastAuditDate TEXT,
              NextAuditDate TEXT,
              FOREIGN KEY (DocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            `CREATE TABLE IF NOT EXISTS tblDocumentValidation (
              ValidationID INTEGER PRIMARY KEY AUTOINCREMENT,
              DocumentID INTEGER NOT NULL,
              RuleID TEXT,
              Result TEXT,
              ValidatedDate TEXT,
              FOREIGN KEY (DocumentID) REFERENCES tblDocument(DocumentID) ON DELETE CASCADE
            )`,
            // WP-18 · E2 — Enterprise Document Engine indexes (additive, idempotent).
            `CREATE INDEX IF NOT EXISTS idx_tblDocument_number ON tblDocument(DocumentNumber)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocument_status ON tblDocument(DocumentStatus)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocument_type ON tblDocument(DocumentType)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocument_workflow ON tblDocument(WorkflowID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocument_owner ON tblDocument(Owner)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocument_department ON tblDocument(Department)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocument_site ON tblDocument(Site)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocument_reviewdate ON tblDocument(ReviewDate)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocument_expirydate ON tblDocument(ExpiryDate)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentVersion_doc ON tblDocumentVersion(DocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentMetadata_doc ON tblDocumentMetadata(DocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentRelationship_from ON tblDocumentRelationship(FromDocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentRelationship_to ON tblDocumentRelationship(ToDocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentApproval_doc ON tblDocumentApproval(DocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentAcknowledgement_doc ON tblDocumentAcknowledgement(DocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentDistribution_doc ON tblDocumentDistribution(DocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentAccess_doc ON tblDocumentAccess(DocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentNotification_doc ON tblDocumentNotification(DocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentSearchIndex_doc ON tblDocumentSearchIndex(DocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentCompliance_doc ON tblDocumentCompliance(DocumentID)`,
            `CREATE INDEX IF NOT EXISTS idx_tblDocumentValidation_doc ON tblDocumentValidation(DocumentID)`,
            // Legacy hot-path index (additive only; created only if absent).
            `CREATE INDEX IF NOT EXISTS idx_tblFiles_entity ON tblFiles(EntityType, EntityID)`,

            // ═══════════════════════════════════════════════════════════════
            // GOVERNANCE FOUNDATION (R1 versioning · R2 approvals · R3 tenancy · R4 roles)
            // All additive/idempotent. Built onto the live tblFiles model (not the
            // dormant Enterprise Document Engine). SQLite backfills existing rows with
            // the column DEFAULT, so every current row lands in tenant 1 automatically.
            // ═══════════════════════════════════════════════════════════════

            // R3 — Tenant registry (isolation-ready; seeded to a single org below).
            `CREATE TABLE IF NOT EXISTS tblTenant (
              TenantID INTEGER PRIMARY KEY AUTOINCREMENT,
              Name TEXT NOT NULL,
              Slug TEXT UNIQUE,
              Status TEXT DEFAULT 'Active',
              CreatedDate TEXT DEFAULT (datetime('now'))
            )`,
            // R3 — TenantID on identity + content-pipeline tables (DEFAULT 1 = seeded org).
            "ALTER TABLE tblPswd ADD COLUMN TenantID INTEGER DEFAULT 1",
            "ALTER TABLE tblStaff ADD COLUMN TenantID INTEGER DEFAULT 1",
            "ALTER TABLE tblFiles ADD COLUMN TenantID INTEGER DEFAULT 1",
            "ALTER TABLE tblKBArticle ADD COLUMN TenantID INTEGER DEFAULT 1",
            "ALTER TABLE tblKBCategory ADD COLUMN TenantID INTEGER DEFAULT 1",
            "ALTER TABLE tblTest ADD COLUMN TenantID INTEGER DEFAULT 1",
            "ALTER TABLE tblFormTemplate ADD COLUMN TenantID INTEGER DEFAULT 1",
            "ALTER TABLE tblTerminology ADD COLUMN TenantID INTEGER DEFAULT 1",
            "ALTER TABLE tblTrainMatCat ADD COLUMN TenantID INTEGER DEFAULT 1",
            "ALTER TABLE tblImageGen ADD COLUMN TenantID INTEGER DEFAULT 1",
            `CREATE INDEX IF NOT EXISTS idx_tblFiles_tenant ON tblFiles(TenantID)`,

            // R4 — role assignment for RBAC (comma-separated canonical role names, e.g. "TRAINER,SAFETY").
            // Consumed by lib/auth (deriveSessionPermissions). Admins keep full access regardless.
            "ALTER TABLE tblPswd ADD COLUMN Roles TEXT",

            // R2 — governance status machine on the live document store.
            // Status: 'Draft' | 'Under Review' | 'Approved' | 'Published'.
            "ALTER TABLE tblFiles ADD COLUMN Status TEXT",
            "ALTER TABLE tblFiles ADD COLUMN ReviewedBy TEXT",
            "ALTER TABLE tblFiles ADD COLUMN ReviewedDate TEXT",
            "ALTER TABLE tblFiles ADD COLUMN PublishedBy TEXT",
            "ALTER TABLE tblFiles ADD COLUMN PublishedDate TEXT",
            // R1 — current-version pointer on tblFiles + immutable version history table.
            "ALTER TABLE tblFiles ADD COLUMN Version INTEGER DEFAULT 1",
            `CREATE TABLE IF NOT EXISTS tblFileVersion (
              VersionID INTEGER PRIMARY KEY AUTOINCREMENT,
              FileID INTEGER NOT NULL,
              TenantID INTEGER DEFAULT 1,
              Version INTEGER NOT NULL,
              FileName TEXT,
              StoredName TEXT,
              MimeType TEXT,
              FileSize INTEGER,
              StructuredData TEXT,
              ChangeNote TEXT,
              ChangedBy TEXT,
              ChangedDate TEXT DEFAULT (datetime('now'))
            )`,
            `CREATE INDEX IF NOT EXISTS idx_tblFileVersion_file ON tblFileVersion(FileID)`,

            // ── Master / Derived version model ──────────────────────────────
            // A derived document (e.g. a Level-1 plain-language variant of a master SOP) links
            // back to its master via MasterFileID and records what it varies by. When the master
            // is edited, every derivative is flagged MasterStale=1 ("review required"); nothing
            // is silently overwritten. Distinct from the translator's SourceFileID/TargetLang.
            "ALTER TABLE tblFiles ADD COLUMN MasterFileID INTEGER",
            "ALTER TABLE tblFiles ADD COLUMN DerivedProfile TEXT",
            "ALTER TABLE tblFiles ADD COLUMN DerivedDepth TEXT",
            "ALTER TABLE tblFiles ADD COLUMN DerivedLang TEXT",
            "ALTER TABLE tblFiles ADD COLUMN MasterStale INTEGER DEFAULT 0",
            "ALTER TABLE tblFiles ADD COLUMN MasterVersion INTEGER",
            `CREATE INDEX IF NOT EXISTS idx_tblFiles_master ON tblFiles(MasterFileID)`
          ];
          db.serialize(() => {
            migrations.forEach(m => db.run(m, () => {}));
            // ── Full multi-tenant rollout (Stage 1) — additive TenantID on the remaining active
            // tenant-owned tables. DEFAULT 1 backfills every existing row into the seeded org, so
            // behaviour is unchanged until per-module query filtering is enabled (later stages).
            // EXCLUDED on purpose: tblConfig (global infra + keys), tblAudit/tblAuditLogin (logs
            // already carry tenant in the log context), tblDoc (legacy lookup), and the dormant
            // Enterprise Document Engine tables (tblDocument*, 0 rows, unwired). Idempotent — a
            // duplicate-column error on a table that already has TenantID is ignored.
            const MT_TENANT_TABLES = [
              // People / employment
              'tblEmpJob', 'tblEmpJobHist', 'tblEmpSup', 'tblEmpType',
              // Training records / certs / classes
              'tblCerts', 'tblClass', 'tblClassLoc', 'tblRegister', 'tblOffer', 'tblRqd', 'tblExpPeriod', 'tblFollow',
              'tblTrainer', 'tblTrainerCert', 'tblTrainType', 'tblGuide',
              // Competency
              'tblCompetency', 'tblCompetencyFramework', 'tblCompetencyRecord', 'tblCompetencyReq',
              // Assessments (attempts/answers; definitions tblTest already scoped)
              'tblExam', 'tblExamScore', 'tblExamWrongQ', 'tblScore', 'tblQ', 'tblQA',
              'tblFormField', 'tblFormAnswer', 'tblFormSubmission',
              // Rostering / attendance / leave
              'tblRoster', 'tblShift', 'tblShiftPattern', 'tblShiftPatternDay', 'tblShiftType',
              'tblAttendance', 'tblAssignment', 'tblLeaveBooking', 'tblLeaveType',
              // Equipment
              'tblEquipment', 'tblEquipmentType', 'tblEquipmentBreakdown', 'tblEquipmentService',
              // HR / onboarding / disciplinary
              'tblDisciplinary', 'tblDisciplinaryDoc', 'tblOnboarding', 'tblOnboardingDoc', 'tblOnboardingMedical', 'tblOnboardingReview',
              // Org lookups (per-tenant)
              'tblDept', 'tblJobs', 'tblLoc',
              // Misc content / notifications / translation memory
              'tblNotes', 'tblNotice', 'tblTip', 'tblWorkflow', 'tblKBRating', 'tblTransMemory', 'tblTransSegment',
            ];
            MT_TENANT_TABLES.forEach(t => db.run(`ALTER TABLE ${t} ADD COLUMN TenantID INTEGER DEFAULT 1`, () => {}));
            // ── Governance foundation seed/backfill (R1–R4) ──────────────────
            // Seed the single default tenant (Akara Resources) as TenantID 1 so every
            // existing DEFAULT-1 row is correctly owned. Idempotent.
            db.run("INSERT OR IGNORE INTO tblTenant (TenantID, Name, Slug, Status) VALUES (1, 'Akara Resources', 'akara', 'Active')", () => {});
            // Backfill governance Status on existing documents from the legacy Approved flag,
            // so enforcement has a sensible starting state (no surprise lock-outs):
            //   Approved=1 -> 'Approved'  ·  Approved=0 (AI drafts) -> 'Draft'.
            db.run("UPDATE tblFiles SET Status='Approved' WHERE Status IS NULL AND (Approved=1 OR Approved IS NULL)", () => {});
            db.run("UPDATE tblFiles SET Status='Draft' WHERE Status IS NULL AND Approved=0", () => {});
            db.run("UPDATE tblFiles SET Version=1 WHERE Version IS NULL", () => {});
            // Backfill Folder for existing docs: TS categories -> training-standards, other docs -> library
            db.run("UPDATE tblFiles SET Folder='training-standards' WHERE Folder IS NULL AND EntityType='document' AND Category IN ('Training Standards Document','Policy','Standard','Plan','Checklist','Training Standards Document (AI draft)','Policy (AI draft)','Standard (AI draft)','Plan (AI draft)','Checklist (AI draft)')", () => {});
            db.run("UPDATE tblFiles SET Folder='library' WHERE Folder IS NULL AND EntityType='document'", () => {});
            // Seed Training Material categories once
            db.get('SELECT COUNT(*) AS c FROM tblTrainMatCat', (e, row) => {
              if (!e && row && row.c === 0) {
                ['Haul Truck Training Material', 'CAT777', 'CAT745'].forEach((n, i) =>
                  db.run('INSERT OR IGNORE INTO tblTrainMatCat (Name, SortOrder) VALUES (?,?)', [n, i]));
              }
            });
            // Hygiene sweep: purge translator rows orphaned by deleted files (self-heals on every boot)
            db.run('DELETE FROM tblTransSegment WHERE JobFileID NOT IN (SELECT FileID FROM tblFiles)', () => {});
            db.run('DELETE FROM tblTransMemory WHERE Approved=0 AND JobFileID IS NOT NULL AND JobFileID NOT IN (SELECT FileID FROM tblFiles)', () => {});
            // Seed standard equipment types once (only if the table is empty)
            db.get('SELECT COUNT(*) AS c FROM tblEquipmentType', (e, row) => {
              if (!e && row && row.c === 0) {
                const seeds = [
                  ['Caterpillar 745C',  'Haul Truck',     'Caterpillar', '745C',  250, '#FBC02D', 'Articulated haul truck'],
                  ['Caterpillar 777F',  'Haul Truck',     'Caterpillar', '777F',  500, '#FBC02D', 'Off-highway haul truck'],
                  ['Komatsu PC2000-8',  'Excavator',      'Komatsu',     'PC2000-8', 500, '#facc15', 'Large hydraulic excavator'],
                  ['Caterpillar D11T',  'Bulldozer',      'Caterpillar', 'D11T',  500, '#FBC02D', 'Track-type tractor'],
                  ['Caterpillar 16M',   'Grader',         'Caterpillar', '16M',   500, '#FBC02D', 'Motor grader'],
                  ['Caterpillar 988K',  'Wheel Loader',   'Caterpillar', '988K',  500, '#FBC02D', 'Large wheel loader'],
                  ['Atlas Copco D65',   'Drill Rig',      'Atlas Copco', 'D65',   250, '#3b82f6', 'Rotary blasthole drill'],
                  ['Caterpillar 793F',  'Haul Truck',     'Caterpillar', '793F',  500, '#FBC02D', 'Ultra-class haul truck']
                ];
                seeds.forEach(s => db.run('INSERT OR IGNORE INTO tblEquipmentType (Name, Category, Manufacturer, ModelNumber, ServiceIntervalHours, Color, Description) VALUES (?,?,?,?,?,?,?)', s, () => {}));
              }
            });
            // Seed standard leave types once (only if the table is empty)
            db.get('SELECT COUNT(*) AS c FROM tblLeaveType', (e, row) => {
              if (!e && row && row.c === 0) {
                const seeds = [
                  ['Annual Leave',     '#10b981', 1, 20, 'Paid annual / vacation leave'],
                  ['Sick Leave',       '#ef4444', 1, 10, 'Paid sick leave (medical certificate may be required)'],
                  ['Personal Leave',   '#8b5cf6', 1, 3,  'Paid personal / family leave'],
                  ['Bereavement',      '#64748b', 1, 5,  'Paid bereavement leave'],
                  ['Unpaid Leave',     '#94a3b8', 0, 0,  'Approved unpaid leave of absence'],
                  ['Training',         '#3b82f6', 1, 0,  'Off-site training / development'],
                  ['Public Holiday',   '#FBC02D', 1, 0,  'Public / statutory holiday']
                ];
                seeds.forEach(s => db.run('INSERT OR IGNORE INTO tblLeaveType (Name, Color, Paid, DefaultDays, Description) VALUES (?,?,?,?,?)', s, () => {}));
              }
            });
            // Seed default shift types once (only if the table is empty)
            db.get('SELECT COUNT(*) AS c FROM tblShiftType', (e, row) => {
              if (!e && row && row.c === 0) {
                const defaults = [
                  ['Day',   '#0ea5e9', '06:00', '18:00', 1, 0],
                  ['Night', '#6366f1', '18:00', '06:00', 2, 0],
                  ['Early', '#10b981', '05:00', '13:00', 3, 0],
                  ['Late',  '#f59e0b', '13:00', '21:00', 4, 0],
                  ['Off',   '#cbd5e1', null,    null,    5, 1]
                ];
                defaults.forEach(d => db.run(
                  'INSERT INTO tblShiftType (Label,Color,StartTime,EndTime,SortOrder,IsOff) VALUES (?,?,?,?,?,?)', d, () => {}));
              }
            });
          });
          // Backfill: ensure every employee with a primary JobID has a matching tblEmpJob role row
          db.run(`INSERT INTO tblEmpJob (EmpID, JobID, IsPrimary, DateAssigned, LastUpdateBy)
            SELECT s.StaffID, s.JobID, 1, date('now'), 'system'
            FROM tblStaff s
            WHERE s.JobID IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM tblEmpJob ej WHERE ej.EmpID=s.StaffID AND ej.JobID=s.JobID AND (ej.DateDeleted IS NULL OR ej.DateDeleted=''))`, () => {});
          _db = db;
          resolve(db);
        });
      });
    });
  });
}

function getDb() {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

module.exports = { initDb, getDb, dbAll, dbGet, dbRun, DB_PATH };
