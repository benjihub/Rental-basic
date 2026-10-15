import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import crypto from 'node:crypto';

export const DB_PATH = resolve(process.env.DB_PATH || './data/rental-manager.sqlite');
mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

export function nowIso(){ return new Date().toISOString(); }
export function today(){ return new Date().toISOString().slice(0,10); }
export function monthKey(date = new Date()){
  const d = typeof date === 'string' ? new Date(date + (date.length === 10 ? 'T12:00:00' : '')) : date;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
export function addMonths(ym, n){
  const [y,m] = ym.split('-').map(Number);
  const d = new Date(y, m-1+n, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
export function dueDateForMonth(ym, dueDay){
  const [y,m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${ym}-${String(Math.min(Number(dueDay)||1,last)).padStart(2,'0')}`;
}
export function uid(prefix){ return `${prefix}_${crypto.randomUUID().replaceAll('-','').slice(0,12)}`; }
export function receiptNo(){
  const prefix = String(db.prepare('SELECT receipt_prefix FROM settings WHERE id=1').get()?.receipt_prefix || 'R').replace(/[^A-Za-z0-9]/g,'').slice(0,8) || 'R';
  const like = `${prefix}-%`;
  const start = prefix.length + 2;
  const next = db.prepare('SELECT COALESCE(MAX(CAST(SUBSTR(receipt_number,?) AS INTEGER)),0)+1 n FROM payments WHERE receipt_number LIKE ?').get(start, like).n;
  return `${prefix}-${String(next).padStart(6,'0')}`;
}
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')){
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(password, stored){
  const [salt, expected] = String(stored||'').split(':');
  if(!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const exp = Buffer.from(expected,'hex');
  return exp.length === actual.length && crypto.timingSafeEqual(exp, actual);
}

export function initDb(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings(
      id INTEGER PRIMARY KEY CHECK(id=1), business_name TEXT NOT NULL DEFAULT 'Rental Manager',
      phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '', currency TEXT NOT NULL DEFAULT 'UGX',
      default_due_day INTEGER NOT NULL DEFAULT 5, receipt_prefix TEXT NOT NULL DEFAULT 'R', logo_url TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS rooms(
      id TEXT PRIMARY KEY, room_number TEXT NOT NULL UNIQUE, name TEXT DEFAULT '', type TEXT NOT NULL,
      floor TEXT DEFAULT '', monthly_rent INTEGER NOT NULL CHECK(monthly_rent>=0), status TEXT NOT NULL DEFAULT 'Available',
      notes TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenants(
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT NOT NULL, alternate_phone TEXT DEFAULT '',
      email TEXT DEFAULT '', id_number TEXT DEFAULT '', emergency_contact_name TEXT DEFAULT '', emergency_contact_phone TEXT DEFAULT '',
      address TEXT DEFAULT '', notes TEXT DEFAULT '', archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rentals(
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), room_id TEXT NOT NULL REFERENCES rooms(id),
      move_in_date TEXT NOT NULL, move_out_date TEXT, monthly_rent INTEGER NOT NULL CHECK(monthly_rent>=0),
      deposit_amount INTEGER NOT NULL DEFAULT 0, deposit_received INTEGER NOT NULL DEFAULT 0,
      rent_due_day INTEGER NOT NULL DEFAULT 5, status TEXT NOT NULL DEFAULT 'Active', notes TEXT DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_room ON rentals(room_id) WHERE status='Active';
    CREATE TABLE IF NOT EXISTS rent_charges(
      id TEXT PRIMARY KEY, rental_id TEXT NOT NULL REFERENCES rentals(id), tenant_id TEXT NOT NULL REFERENCES tenants(id),
      room_id TEXT NOT NULL REFERENCES rooms(id), billing_month TEXT NOT NULL, amount_due INTEGER NOT NULL,
      due_date TEXT NOT NULL, amount_paid INTEGER NOT NULL DEFAULT 0, balance INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Unpaid', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(rental_id,billing_month)
    );
    CREATE TABLE IF NOT EXISTS payments(
      id TEXT PRIMARY KEY, receipt_number TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL REFERENCES tenants(id),
      rental_id TEXT NOT NULL REFERENCES rentals(id), room_id TEXT NOT NULL REFERENCES rooms(id), payment_date TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount>0), payment_method TEXT NOT NULL, reference TEXT DEFAULT '', notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Completed', reversal_reason TEXT DEFAULT '', reversed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_allocations(
      id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id), charge_id TEXT NOT NULL REFERENCES rent_charges(id),
      amount INTEGER NOT NULL CHECK(amount>0), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expenses(
      id TEXT PRIMARY KEY, expense_date TEXT NOT NULL, category TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0),
      description TEXT DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_logs(
      id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT DEFAULT '',
      description TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT OR IGNORE INTO settings(id) VALUES(1)').run();
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if(!count){
    const email = process.env.ADMIN_EMAIL || 'admin@rental.local';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    db.prepare('INSERT INTO users(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)')
      .run(uid('usr'),'Administrator',email,hashPassword(password),nowIso());
  }
}

export function log(action, entityType, entityId, description){
  db.prepare('INSERT INTO activity_logs(id,action,entity_type,entity_id,description,created_at) VALUES(?,?,?,?,?,?)')
    .run(uid('log'),action,entityType,entityId||'',description,nowIso());
}

export function refreshChargeStatus(chargeId){
  const c = db.prepare('SELECT * FROM rent_charges WHERE id=?').get(chargeId);
  if(!c) return;
  const paid = db.prepare(`SELECT COALESCE(SUM(a.amount),0) paid FROM payment_allocations a
    JOIN payments p ON p.id=a.payment_id WHERE a.charge_id=? AND p.status='Completed'`).get(chargeId).paid;
  const balance = Math.max(0, c.amount_due - paid);
  let status = balance === 0 ? 'Paid' : paid > 0 ? 'Part Paid' : 'Unpaid';
  if(balance > 0 && c.due_date < today()) status = 'Overdue';
  db.prepare('UPDATE rent_charges SET amount_paid=?, balance=?, status=?, updated_at=? WHERE id=?')
    .run(paid,balance,status,nowIso(),chargeId);
}

export function ensureCharge(rental, billingMonth){
  const existing = db.prepare('SELECT * FROM rent_charges WHERE rental_id=? AND billing_month=?').get(rental.id,billingMonth);
  if(existing){ refreshChargeStatus(existing.id); return db.prepare('SELECT * FROM rent_charges WHERE id=?').get(existing.id); }
  const id = uid('chg');
  const dueDate = dueDateForMonth(billingMonth,rental.rent_due_day);
  db.prepare(`INSERT INTO rent_charges(id,rental_id,tenant_id,room_id,billing_month,amount_due,due_date,amount_paid,balance,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,rental.id,rental.tenant_id,rental.room_id,billingMonth,rental.monthly_rent,dueDate,0,rental.monthly_rent,dueDate<today()?'Overdue':'Unpaid',nowIso(),nowIso());
  return db.prepare('SELECT * FROM rent_charges WHERE id=?').get(id);
}

export function ensureChargesThroughCurrent(){
  const rentals = db.prepare("SELECT * FROM rentals WHERE status='Active'").all();
  const current = monthKey();
  for(const rental of rentals){
    let ym = monthKey(rental.move_in_date);
    let guard=0;
    while(ym <= current && guard++ < 240){ ensureCharge(rental, ym); ym = addMonths(ym,1); }
  }
  const open = db.prepare("SELECT id FROM rent_charges WHERE balance>0").all();
  for(const c of open) refreshChargeStatus(c.id);
}

export function allocatePayment(payment, preferredMonth=''){
  const rental = db.prepare('SELECT * FROM rentals WHERE id=?').get(payment.rental_id);
  if(!rental) throw new Error('Rental not found');
  ensureChargesThroughCurrent();
  if(preferredMonth) ensureCharge(rental, preferredMonth);
  let remaining = payment.amount;
  let charges = db.prepare(`SELECT * FROM rent_charges WHERE rental_id=? AND balance>0
    ORDER BY CASE WHEN billing_month=? THEN 0 ELSE 1 END, billing_month ASC`).all(rental.id, preferredMonth||'');
  let futureMonth = db.prepare('SELECT MAX(billing_month) m FROM rent_charges WHERE rental_id=?').get(rental.id).m || monthKey(rental.move_in_date);
  while(remaining > 0){
    let charge = charges.find(c=>c.balance>0);
    if(!charge){
      do {
        futureMonth = addMonths(futureMonth,1);
        charge = ensureCharge(rental,futureMonth);
      } while(charge.balance <= 0);
      charges.push(charge);
    }
    const amt = Math.min(remaining, charge.balance);
    db.prepare('INSERT INTO payment_allocations(id,payment_id,charge_id,amount,created_at) VALUES(?,?,?,?,?)')
      .run(uid('alc'),payment.id,charge.id,amt,nowIso());
    remaining -= amt;
    refreshChargeStatus(charge.id);
    charge.balance -= amt;
  }
}

export function seedDemoData(){
  if(db.prepare('SELECT COUNT(*) c FROM rooms').get().c) return;
  const t=nowIso();
  const rooms = [
    ['R-01','Room 01','Single','Ground Floor',350000,'Occupied'],
    ['R-02','Room 02','Single','Ground Floor',350000,'Available'],
    ['R-03','Room 03','Double','Ground Floor',450000,'Occupied'],
    ['R-04','Room 04','Self-contained','First Floor',550000,'Occupied'],
    ['R-05','Room 05','Single','First Floor',350000,'Available'],
    ['R-06','Room 06','Double','First Floor',450000,'Maintenance']
  ];
  for(const [num,name,type,floor,rent,status] of rooms){ db.prepare('INSERT INTO rooms(id,room_number,name,type,floor,monthly_rent,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid('room'),num,name,type,floor,rent,status,'',t,t); }
  const people = [
    ['Sarah Nakato','0701000001','sarah@example.com'],['John Kato','0701000002','john@example.com'],['Daniel Okello','0701000003','daniel@example.com']
  ];
  const tids=[];
  for(const [name,phone,email] of people){ const id=uid('ten'); tids.push(id); db.prepare('INSERT INTO tenants(id,full_name,phone,email,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,name,phone,email,t,t); }
  const occRooms = db.prepare("SELECT * FROM rooms WHERE status='Occupied' ORDER BY room_number").all();
  occRooms.forEach((room,i)=>{
    const rid=uid('rent');
    db.prepare(`INSERT INTO rentals(id,tenant_id,room_id,move_in_date,monthly_rent,deposit_amount,deposit_received,rent_due_day,status,notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(rid,tids[i],room.id,'2026-09-01',room.monthly_rent,room.monthly_rent,room.monthly_rent,5,'Active','',t,t);
  });
  ensureChargesThroughCurrent();
}
