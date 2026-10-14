-- TrainTrack Web - SQLite Schema
-- Matches TRAINTRACK12V1.accdb structure

CREATE TABLE IF NOT EXISTS tblDept (
  DeptID INTEGER PRIMARY KEY AUTOINCREMENT,
  Department TEXT,
  SelectDept INTEGER DEFAULT 0,
  linkall INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tblLoc (
  LocID INTEGER PRIMARY KEY AUTOINCREMENT,
  Location TEXT,
  LinkAll INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tblShift (
  ShiftID INTEGER PRIMARY KEY AUTOINCREMENT,
  Shift TEXT
);

CREATE TABLE IF NOT EXISTS tblEmpType (
  empTypeID INTEGER PRIMARY KEY AUTOINCREMENT,
  empType TEXT
);

CREATE TABLE IF NOT EXISTS tblJobs (
  JobID INTEGER PRIMARY KEY AUTOINCREMENT,
  Title TEXT,
  "Group" TEXT
);

CREATE TABLE IF NOT EXISTS tblTrainType (
  TrainTypeID INTEGER PRIMARY KEY AUTOINCREMENT,
  TrainType TEXT
);

CREATE TABLE IF NOT EXISTS tblExpPeriod (
  PeriodID INTEGER PRIMARY KEY AUTOINCREMENT,
  ExpPeriod TEXT,
  ExtText TEXT
);

CREATE TABLE IF NOT EXISTS tblClassLoc (
  ClassLocID INTEGER PRIMARY KEY AUTOINCREMENT,
  ClassLoc TEXT,
  ClassCapacity INTEGER
);

CREATE TABLE IF NOT EXISTS tblDoc (
  DocID INTEGER PRIMARY KEY AUTOINCREMENT,
  DocName TEXT,
  DocNum TEXT,
  Rev TEXT,
  CertID INTEGER,
  ReleaseDate TEXT,
  Retrain INTEGER DEFAULT 0,
  ExpireDate TEXT
);

CREATE TABLE IF NOT EXISTS tblCerts (
  CertID INTEGER PRIMARY KEY AUTOINCREMENT,
  CertName TEXT NOT NULL,
  CertNum TEXT,
  CertType TEXT,
  Status TEXT DEFAULT 'Active',
  Months INTEGER,
  Exam INTEGER DEFAULT 0,
  start TEXT,
  end TEXT,
  TrHours REAL,
  CurrentRev TEXT,
  LinkDoc TEXT,
  DateRecAdded TEXT,
  AddedBy TEXT,
  DateRecDeleted TEXT,
  DeletedBy TEXT,
  MachineName TEXT,
  StandardBased INTEGER DEFAULT 0,
  LastUpdateBy TEXT,
  GroupReq INTEGER,
  TrainDesc TEXT,
  ReleaseDate TEXT,
  TrainTypeID INTEGER,
  AltText TEXT,
  ExpPeriod TEXT,
  GracePer INTEGER,
  LocID INTEGER,
  LinkAll INTEGER DEFAULT 0,
  DocID INTEGER,
  FOREIGN KEY (TrainTypeID) REFERENCES tblTrainType(TrainTypeID),
  FOREIGN KEY (LocID) REFERENCES tblLoc(LocID),
  FOREIGN KEY (DocID) REFERENCES tblDoc(DocID)
);

CREATE TABLE IF NOT EXISTS tblStaff (
  StaffID INTEGER PRIMARY KEY AUTOINCREMENT,
  LastName TEXT NOT NULL,
  FirstName TEXT NOT NULL,
  Status TEXT DEFAULT 'Active',
  Gender TEXT,
  FileNum TEXT,
  Supervisor TEXT,
  extension TEXT,
  JobID INTEGER,
  StartDate TEXT,
  EndDate TEXT,
  Note TEXT,
  Other TEXT,
  Pswd TEXT,
  "Select" INTEGER DEFAULT 0,
  Shift TEXT,
  Location TEXT,
  Email TEXT,
  empTypeID INTEGER,
  DeptID INTEGER,
  empLink TEXT,
  LocID INTEGER,
  ShiftID INTEGER,
  Address TEXT,
  DOB TEXT,
  SS TEXT,
  HomePhone TEXT,
  CellPhone TEXT,
  DateRecAdded TEXT DEFAULT (date('now')),
  AddedBy TEXT,
  DateRecDeleted TEXT,
  DeletedBy TEXT,
  MachineName TEXT,
  LastUpdateBy TEXT,
  LinkAll INTEGER DEFAULT 0,
  SupID INTEGER,
  FOREIGN KEY (JobID) REFERENCES tblJobs(JobID),
  FOREIGN KEY (DeptID) REFERENCES tblDept(DeptID),
  FOREIGN KEY (LocID) REFERENCES tblLoc(LocID),
  FOREIGN KEY (ShiftID) REFERENCES tblShift(ShiftID),
  FOREIGN KEY (empTypeID) REFERENCES tblEmpType(empTypeID)
);

CREATE TABLE IF NOT EXISTS tblPswd (
  PSWDID INTEGER PRIMARY KEY AUTOINCREMENT,
  UserName TEXT NOT NULL UNIQUE,
  Password TEXT,
  confirm TEXT,
  USER TEXT,
  MACHINENAME TEXT,
  staffID INTEGER,
  Admin INTEGER DEFAULT 0,
  Standard INTEGER DEFAULT 0,
  Restricted INTEGER DEFAULT 0,
  ExamOnly INTEGER DEFAULT 0,
  DeptID INTEGER,
  UpdateBy TEXT,
  LinkAll INTEGER DEFAULT 0,
  DateChanged TEXT,
  PrevPswd TEXT,
  DateDeleted TEXT,
  DeletedBy TEXT,
  HashPass TEXT,
  LocID INTEGER,
  UserStatus TEXT DEFAULT 'Active',
  ReadPrint INTEGER DEFAULT 0,
  FOREIGN KEY (staffID) REFERENCES tblStaff(StaffID)
);

CREATE TABLE IF NOT EXISTS tblOffer (
  OfferID INTEGER PRIMARY KEY AUTOINCREMENT,
  CertID INTEGER,
  OfferedBy TEXT,
  ClassName TEXT,
  ClassNum TEXT,
  Cost REAL,
  Location TEXT,
  Hours REAL,
  Book TEXT,
  Rev TEXT,
  ClassLocID INTEGER,
  FOREIGN KEY (CertID) REFERENCES tblCerts(CertID),
  FOREIGN KEY (ClassLocID) REFERENCES tblClassLoc(ClassLocID)
);

CREATE TABLE IF NOT EXISTS tblClass (
  ClassID INTEGER PRIMARY KEY AUTOINCREMENT,
  ClassName TEXT,
  ClassNum TEXT,
  OfferedBy TEXT,
  CertID INTEGER,
  DateTime TEXT,
  EstCost REAL,
  OfferID INTEGER,
  ClassDate TEXT,
  ClassLocation TEXT,
  TimeStart TEXT,
  TimeEnd TEXT,
  ClassLocID INTEGER,
  LinkAll INTEGER DEFAULT 0,
  FOREIGN KEY (CertID) REFERENCES tblCerts(CertID),
  FOREIGN KEY (OfferID) REFERENCES tblOffer(OfferID),
  FOREIGN KEY (ClassLocID) REFERENCES tblClassLoc(ClassLocID)
);

CREATE TABLE IF NOT EXISTS tblRegister (
  RegisterID INTEGER PRIMARY KEY AUTOINCREMENT,
  ClassID INTEGER,
  StaffID INTEGER NOT NULL,
  Complete TEXT,
  Exp TEXT,
  CertID INTEGER NOT NULL,
  State TEXT,
  Paid REAL,
  Score INTEGER,
  Pass INTEGER,
  Rev TEXT,
  RegLink TEXT,
  DueBy TEXT,
  LastUpdateBy TEXT,
  DateDeleted TEXT,
  DeletedBy TEXT,
  SignMean TEXT,
  DateStarted TEXT,
  DateDue TEXT,
  ExamID INTEGER,
  FOREIGN KEY (ClassID) REFERENCES tblClass(ClassID),
  FOREIGN KEY (StaffID) REFERENCES tblStaff(StaffID),
  FOREIGN KEY (CertID) REFERENCES tblCerts(CertID)
);

CREATE TABLE IF NOT EXISTS tblRqd (
  RqdID INTEGER PRIMARY KEY AUTOINCREMENT,
  CertID INTEGER,
  JobID INTEGER,
  StaffID INTEGER,
  DeptID INTEGER,
  ReqTypeID INTEGER,
  DueByDate TEXT,
  LastUpdateBy TEXT,
  DateDeleted TEXT,
  DeletedBy TEXT,
  FOREIGN KEY (CertID) REFERENCES tblCerts(CertID),
  FOREIGN KEY (JobID) REFERENCES tblJobs(JobID),
  FOREIGN KEY (StaffID) REFERENCES tblStaff(StaffID),
  FOREIGN KEY (DeptID) REFERENCES tblDept(DeptID)
);

CREATE TABLE IF NOT EXISTS tblNotes (
  NoteID INTEGER PRIMARY KEY AUTOINCREMENT,
  StaffID INTEGER,
  Date TEXT DEFAULT (date('now')),
  Note TEXT,
  FOREIGN KEY (StaffID) REFERENCES tblStaff(StaffID)
);

CREATE TABLE IF NOT EXISTS tblTest (
  TestID INTEGER PRIMARY KEY AUTOINCREMENT,
  TestName TEXT,
  CertID INTEGER,
  PassScore INTEGER,
  TimeLimit INTEGER,
  Instructions TEXT,
  FOREIGN KEY (CertID) REFERENCES tblCerts(CertID)
);

CREATE TABLE IF NOT EXISTS tblQ (
  QID INTEGER PRIMARY KEY AUTOINCREMENT,
  TestID INTEGER,
  Question TEXT,
  "Order" INTEGER,
  NumAns INTEGER,
  Qimage TEXT,
  HasPic INTEGER DEFAULT 0,
  FOREIGN KEY (TestID) REFERENCES tblTest(TestID)
);

CREATE TABLE IF NOT EXISTS tblQA (
  QAID INTEGER PRIMARY KEY AUTOINCREMENT,
  QID INTEGER,
  Answer TEXT,
  Points INTEGER DEFAULT 0,
  AnswerLetter TEXT,
  FOREIGN KEY (QID) REFERENCES tblQ(QID)
);

CREATE TABLE IF NOT EXISTS tblExam (
  ExamID INTEGER PRIMARY KEY AUTOINCREMENT,
  TestID INTEGER,
  ExamDate TEXT DEFAULT (date('now')),
  EmpID INTEGER,
  FOREIGN KEY (TestID) REFERENCES tblTest(TestID),
  FOREIGN KEY (EmpID) REFERENCES tblStaff(StaffID)
);

CREATE TABLE IF NOT EXISTS tblScore (
  ScoreID INTEGER PRIMARY KEY AUTOINCREMENT,
  ExamID INTEGER,
  QID INTEGER,
  QAID INTEGER,
  Selected INTEGER DEFAULT 0,
  Score INTEGER DEFAULT 0,
  Points INTEGER DEFAULT 0,
  FOREIGN KEY (ExamID) REFERENCES tblExam(ExamID),
  FOREIGN KEY (QID) REFERENCES tblQ(QID),
  FOREIGN KEY (QAID) REFERENCES tblQA(QAID)
);

CREATE TABLE IF NOT EXISTS tblExamScore (
  ExamScoreID INTEGER PRIMARY KEY AUTOINCREMENT,
  EmpID INTEGER,
  CertID INTEGER,
  MaxOfRegisterID INTEGER,
  SumOfScore REAL,
  PassScore INTEGER,
  ExamDate TEXT,
  ExamID INTEGER,
  signby TEXT,
  signpswd TEXT,
  signdate TEXT,
  signmean INTEGER,
  FOREIGN KEY (EmpID) REFERENCES tblStaff(StaffID),
  FOREIGN KEY (CertID) REFERENCES tblCerts(CertID)
);

CREATE TABLE IF NOT EXISTS tblFollow (
  FollowID INTEGER PRIMARY KEY AUTOINCREMENT,
  FirstCertID INTEGER,
  FollowCertID INTEGER,
  FollowDays INTEGER,
  FOREIGN KEY (FirstCertID) REFERENCES tblCerts(CertID),
  FOREIGN KEY (FollowCertID) REFERENCES tblCerts(CertID)
);

CREATE TABLE IF NOT EXISTS tblNotice (
  NoticeID INTEGER PRIMARY KEY AUTOINCREMENT,
  NoticeType TEXT,
  CertID INTEGER,
  StaffID INTEGER,
  SentBy TEXT,
  SentDate TEXT DEFAULT (date('now')),
  SentTo TEXT,
  FOREIGN KEY (CertID) REFERENCES tblCerts(CertID),
  FOREIGN KEY (StaffID) REFERENCES tblStaff(StaffID)
);

CREATE TABLE IF NOT EXISTS tblEmpJob (
  EmpJobID INTEGER PRIMARY KEY AUTOINCREMENT,
  EmpID INTEGER,
  JobID INTEGER,
  LastUpdateBy TEXT,
  DateDeleted TEXT,
  FOREIGN KEY (EmpID) REFERENCES tblStaff(StaffID),
  FOREIGN KEY (JobID) REFERENCES tblJobs(JobID)
);

CREATE TABLE IF NOT EXISTS tblEmpSup (
  EmpSupID INTEGER PRIMARY KEY AUTOINCREMENT,
  EmpID INTEGER,
  SupID INTEGER,
  FOREIGN KEY (EmpID) REFERENCES tblStaff(StaffID),
  FOREIGN KEY (SupID) REFERENCES tblStaff(StaffID)
);

CREATE TABLE IF NOT EXISTS tblTip (
  TipID INTEGER PRIMARY KEY AUTOINCREMENT,
  TipTitle TEXT,
  TipTags TEXT,
  TipContent TEXT,
  TipOn INTEGER DEFAULT 1,
  TipGroup INTEGER,
  TipShown INTEGER DEFAULT 0,
  TipCategory TEXT
);

CREATE TABLE IF NOT EXISTS tblGuide (
  GuideID INTEGER PRIMARY KEY AUTOINCREMENT,
  StepNum INTEGER,
  StepText TEXT,
  StepLink TEXT,
  StepTitle TEXT,
  StepImage TEXT
);

CREATE TABLE IF NOT EXISTS tblAudit (
  AuditID INTEGER PRIMARY KEY AUTOINCREMENT,
  AuditDate TEXT DEFAULT (datetime('now')),
  AuditUser TEXT,
  AuditTable TEXT,
  AuditAction TEXT,
  AuditRecord TEXT,
  AuditField TEXT,
  OldValue TEXT,
  NewValue TEXT
);

CREATE TABLE IF NOT EXISTS tblAuditLogin (
  LoginID INTEGER PRIMARY KEY AUTOINCREMENT,
  LoginDate TEXT DEFAULT (datetime('now')),
  LoginUser TEXT,
  MachineName TEXT,
  LoginStatus TEXT
);

-- Assessment form builder: templates, fields, submissions, answers
CREATE TABLE IF NOT EXISTS tblFormTemplate (
  TemplateID INTEGER PRIMARY KEY AUTOINCREMENT,
  Name TEXT NOT NULL,
  Description TEXT,
  CertID INTEGER,            -- qualification awarded on pass
  PassMark INTEGER DEFAULT 80,  -- % of available points needed to pass
  MaterialLink TEXT,         -- default training-material link
  Status TEXT DEFAULT 'Active',
  CreatedBy TEXT,
  CreatedAt TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (CertID) REFERENCES tblCerts(CertID)
);

CREATE TABLE IF NOT EXISTS tblFormField (
  FieldID INTEGER PRIMARY KEY AUTOINCREMENT,
  TemplateID INTEGER NOT NULL,
  OrderNum INTEGER DEFAULT 0,
  FieldType TEXT NOT NULL,   -- section,text,textarea,number,date,select,radio,checkbox,yesno,rating,competency,materiallink
  Label TEXT,
  Options TEXT,              -- JSON array for select/radio/checkbox
  Required INTEGER DEFAULT 0,
  Points INTEGER DEFAULT 0,  -- weight for scored items (competency/yesno/rating)
  HelpText TEXT,
  FOREIGN KEY (TemplateID) REFERENCES tblFormTemplate(TemplateID)
);

CREATE TABLE IF NOT EXISTS tblFormSubmission (
  SubmissionID INTEGER PRIMARY KEY AUTOINCREMENT,
  TemplateID INTEGER NOT NULL,
  EmpID INTEGER,             -- trainee
  TrainerID INTEGER,
  TrainerName TEXT,
  AssessDate TEXT,
  Location TEXT,
  Score INTEGER,
  PossiblePoints INTEGER,
  Passed INTEGER,
  Status TEXT DEFAULT 'Completed',
  TraineeSignature TEXT,     -- base64 PNG
  TrainerSignature TEXT,
  TraineeSignedAt TEXT,
  TrainerSignedAt TEXT,
  RegisterID INTEGER,        -- completion record created on pass
  Notes TEXT,
  SubmittedBy TEXT,
  SubmittedAt TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (TemplateID) REFERENCES tblFormTemplate(TemplateID),
  FOREIGN KEY (EmpID) REFERENCES tblStaff(StaffID)
);

CREATE TABLE IF NOT EXISTS tblFormAnswer (
  AnswerID INTEGER PRIMARY KEY AUTOINCREMENT,
  SubmissionID INTEGER NOT NULL,
  FieldID INTEGER NOT NULL,
  Value TEXT,
  Points INTEGER DEFAULT 0,
  FOREIGN KEY (SubmissionID) REFERENCES tblFormSubmission(SubmissionID),
  FOREIGN KEY (FieldID) REFERENCES tblFormField(FieldID)
);

-- Shift patterns (rotating cycles) and their day definitions
CREATE TABLE IF NOT EXISTS tblShiftPattern (
  PatternID INTEGER PRIMARY KEY AUTOINCREMENT,
  Name TEXT NOT NULL,
  Description TEXT,
  CycleLength INTEGER DEFAULT 7,   -- number of days in the repeating cycle
  Color TEXT DEFAULT '#4f46e5',
  Status TEXT DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS tblShiftPatternDay (
  PatternDayID INTEGER PRIMARY KEY AUTOINCREMENT,
  PatternID INTEGER NOT NULL,
  DayNum INTEGER NOT NULL,          -- 0-based index within the cycle
  ShiftLabel TEXT DEFAULT 'Off',    -- e.g. Day, Night, Early, Off
  StartTime TEXT,
  EndTime TEXT,
  FOREIGN KEY (PatternID) REFERENCES tblShiftPattern(PatternID)
);

-- Roster assignments: a person on a shift on a specific date
CREATE TABLE IF NOT EXISTS tblRoster (
  RosterID INTEGER PRIMARY KEY AUTOINCREMENT,
  PersonType TEXT NOT NULL DEFAULT 'employee',  -- employee | trainer
  PersonID INTEGER NOT NULL,
  RosterDate TEXT NOT NULL,
  ShiftLabel TEXT,
  StartTime TEXT,
  EndTime TEXT,
  PatternID INTEGER,               -- set if generated from a pattern
  Note TEXT,
  CreatedBy TEXT,
  CreatedAt TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_roster_date ON tblRoster(RosterDate);
CREATE INDEX IF NOT EXISTS idx_roster_person ON tblRoster(PersonType, PersonID);

-- Employee job-role history (transitions: assigned / removed / made primary)
CREATE TABLE IF NOT EXISTS tblEmpJobHist (
  HistID INTEGER PRIMARY KEY AUTOINCREMENT,
  EmpID INTEGER NOT NULL,
  JobID INTEGER,
  Action TEXT,            -- Assigned | Removed | Set Primary | Transitioned
  EffectiveDate TEXT DEFAULT (date('now')),
  ChangedBy TEXT,
  ChangedAt TEXT DEFAULT (datetime('now')),
  Note TEXT,
  FOREIGN KEY (EmpID) REFERENCES tblStaff(StaffID),
  FOREIGN KEY (JobID) REFERENCES tblJobs(JobID)
);

-- Trainers / Instructors
CREATE TABLE IF NOT EXISTS tblTrainer (
  TrainerID INTEGER PRIMARY KEY AUTOINCREMENT,
  FirstName TEXT NOT NULL,
  LastName TEXT NOT NULL,
  Email TEXT,
  Phone TEXT,
  TrainerType TEXT DEFAULT 'Internal',   -- Internal | External
  StaffID INTEGER,                        -- link to employee if internal
  Company TEXT,
  HourlyRate REAL,
  DailyRate REAL,
  Status TEXT DEFAULT 'Active',
  Notes TEXT,
  DateAdded TEXT DEFAULT (date('now')),
  FOREIGN KEY (StaffID) REFERENCES tblStaff(StaffID)
);

-- Which courses a trainer is qualified to deliver
CREATE TABLE IF NOT EXISTS tblTrainerCert (
  TrainerCertID INTEGER PRIMARY KEY AUTOINCREMENT,
  TrainerID INTEGER NOT NULL,
  CertID INTEGER NOT NULL,
  FOREIGN KEY (TrainerID) REFERENCES tblTrainer(TrainerID),
  FOREIGN KEY (CertID) REFERENCES tblCerts(CertID)
);

-- File attachments (employee documents, course materials, record evidence)
CREATE TABLE IF NOT EXISTS tblFiles (
  FileID INTEGER PRIMARY KEY AUTOINCREMENT,
  EntityType TEXT NOT NULL,   -- 'staff' | 'cert' | 'register' | 'class'
  EntityID INTEGER NOT NULL,
  FileName TEXT NOT NULL,      -- original display name
  StoredName TEXT NOT NULL,    -- name on disk
  MimeType TEXT,
  FileSize INTEGER,
  Category TEXT,               -- e.g. Certificate, ID, Course Material, Evidence
  Description TEXT,
  UploadedBy TEXT,
  UploadedDate TEXT DEFAULT (datetime('now'))
);

-- Key/value config store (SMTP settings, app preferences)
CREATE TABLE IF NOT EXISTS tblConfig (
  ckey TEXT PRIMARY KEY,
  cvalue TEXT
);

-- Seed default data
INSERT OR IGNORE INTO tblExpPeriod (PeriodID, ExpPeriod, ExtText) VALUES
  (1, 'M', 'Months'),
  (2, 'Y', 'Years'),
  (3, 'D', 'Days'),
  (4, 'N', 'No Expiration');

INSERT OR IGNORE INTO tblTrainType (TrainTypeID, TrainType) VALUES
  (1, 'Classroom'),
  (2, 'Online'),
  (3, 'On-the-Job'),
  (4, 'Self-Study'),
  (5, 'Webinar');

-- Admin user seeded by server.js on first startup
