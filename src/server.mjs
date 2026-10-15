import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import crypto from 'node:crypto';
import { db, initDb, seedDemoData, uid, nowIso, today, monthKey, ensureChargesThroughCurrent, ensureCharge, allocatePayment, refreshChargeStatus, receiptNo, verifyPassword, hashPassword, log } from './db.mjs';

const PORT = Number(process.env.PORT || 3003);
const PUBLIC = resolve('./public');
const sessions = new Map();
initDb();
if(process.env.SEED_DEMO !== 'false') seedDemoData();
ensureChargesThroughCurrent();

const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json'};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const bad=(res,msg,status=400)=>json(res,status,{error:msg});
const body=async req=>{let s='';for await(const c of req){s+=c;if(s.length>1e6)throw new Error('Payload too large');}return s?JSON.parse(s):{};};
const cookies=req=>Object.fromEntries(String(req.headers.cookie||'').split(';').filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i).trim(),decodeURIComponent(x.slice(i+1))]}));
const auth=req=>{const sid=cookies(req).sid;return sid&&sessions.get(sid);};
const requireAuth=(req,res)=>{const u=auth(req);if(!u){bad(res,'Unauthorized',401);return null;}return u;};
const q=(url)=>Object.fromEntries(url.searchParams.entries());
const int=v=>Math.round(Number(v||0));
const text=v=>String(v??'').trim();
const setting=()=>db.prepare('SELECT * FROM settings WHERE id=1').get();

function serveFile(req,res,url){
  let path=url.pathname==='/'?'/index.html':url.pathname;
  if(path.includes('..')) return false;
  const fp=join(PUBLIC,path);
  if(!existsSync(fp)||!statSync(fp).isFile()) return false;
  res.writeHead(200,{'Content-Type':MIME[extname(fp)]||'application/octet-stream'});res.end(readFileSync(fp));return true;
}
function queryOne(sql,...args){return db.prepare(sql).get(...args)}
function queryAll(sql,...args){return db.prepare(sql).all(...args)}
function activeRentalForRoom(roomId){return queryOne("SELECT * FROM rentals WHERE room_id=? AND status='Active'",roomId)}
function recalcRoom(roomId){const active=activeRentalForRoom(roomId);if(active)db.prepare("UPDATE rooms SET status='Occupied',updated_at=? WHERE id=?").run(nowIso(),roomId);else{const r=queryOne('SELECT status FROM rooms WHERE id=?',roomId);if(r&&r.status==='Occupied')db.prepare("UPDATE rooms SET status='Available',updated_at=? WHERE id=?").run(nowIso(),roomId);}}

async function api(req,res,url){
  try{
    if(url.pathname==='/api/login'&&req.method==='POST'){
      const d=await body(req);const user=queryOne('SELECT * FROM users WHERE lower(email)=lower(?)',text(d.email));
      if(!user||!verifyPassword(String(d.password||''),user.password_hash))return bad(res,'Invalid email or password',401);
      const sid=crypto.randomBytes(32).toString('hex');sessions.set(sid,{id:user.id,name:user.name,email:user.email});
      res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':`sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`});return res.end(JSON.stringify({user:{id:user.id,name:user.name,email:user.email}}));
    }
    if(url.pathname==='/api/logout'&&req.method==='POST'){
      const sid=cookies(req).sid;if(sid)sessions.delete(sid);res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});return res.end('{}');
    }
    const user=requireAuth(req,res);if(!user)return;
    if(url.pathname==='/api/me'&&req.method==='GET')return json(res,200,{user,settings:setting()});
    ensureChargesThroughCurrent();

    if(url.pathname==='/api/dashboard'&&req.method==='GET'){
      const rooms=queryAll('SELECT status,COUNT(*) count FROM rooms GROUP BY status');
      const monthlyCollected=queryOne("SELECT COALESCE(SUM(amount),0) total FROM payments WHERE status='Completed' AND substr(payment_date,1,7)=?",monthKey()).total;
      const due=queryOne("SELECT COALESCE(SUM(balance),0) total FROM rent_charges WHERE balance>0").total;
      const overdue=queryOne("SELECT COALESCE(SUM(balance),0) total FROM rent_charges WHERE status='Overdue'").total;
      const recent=queryAll(`SELECT p.*,t.full_name,r.room_number FROM payments p JOIN tenants t ON t.id=p.tenant_id JOIN rooms r ON r.id=p.room_id ORDER BY p.payment_date DESC,p.created_at DESC LIMIT 6`);
      const rentDue=queryAll(`SELECT c.*,t.full_name,r.room_number FROM rent_charges c JOIN tenants t ON t.id=c.tenant_id JOIN rooms r ON r.id=c.room_id WHERE c.balance>0 ORDER BY c.due_date ASC LIMIT 8`);
      const totalRooms=queryOne('SELECT COUNT(*) c FROM rooms').c;
      return json(res,200,{totalRooms,rooms,monthlyCollected,due,overdue,recent,rentDue});
    }

    if(url.pathname==='/api/rooms'&&req.method==='GET'){
      const data=queryAll(`SELECT r.*,t.full_name tenant_name,re.id rental_id FROM rooms r LEFT JOIN rentals re ON re.room_id=r.id AND re.status='Active' LEFT JOIN tenants t ON t.id=re.tenant_id ORDER BY r.room_number`);return json(res,200,data);
    }
    if(url.pathname==='/api/rooms'&&req.method==='POST'){
      const d=await body(req);if(!text(d.room_number)||!text(d.type)||int(d.monthly_rent)<0)return bad(res,'Room number, type and valid rent are required');
      const id=uid('room'),t=nowIso();db.prepare('INSERT INTO rooms(id,room_number,name,type,floor,monthly_rent,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,text(d.room_number),text(d.name),text(d.type),text(d.floor),int(d.monthly_rent),text(d.status)||'Available',text(d.notes),t,t);log('create','room',id,`Room ${text(d.room_number)} created`);return json(res,201,queryOne('SELECT * FROM rooms WHERE id=?',id));
    }
    if(url.pathname.match(/^\/api\/rooms\/[^/]+$/)&&req.method==='PUT'){
      const id=url.pathname.split('/').pop(),d=await body(req),r=queryOne('SELECT * FROM rooms WHERE id=?',id);if(!r)return bad(res,'Room not found',404);
      const status=activeRentalForRoom(id)?'Occupied':(text(d.status)||r.status);
      db.prepare('UPDATE rooms SET room_number=?,name=?,type=?,floor=?,monthly_rent=?,status=?,notes=?,updated_at=? WHERE id=?').run(text(d.room_number)||r.room_number,text(d.name),text(d.type)||r.type,text(d.floor),int(d.monthly_rent),status,text(d.notes),nowIso(),id);log('update','room',id,`Room ${text(d.room_number)||r.room_number} updated`);return json(res,200,queryOne('SELECT * FROM rooms WHERE id=?',id));
    }

    if(url.pathname==='/api/tenants'&&req.method==='GET'){
      const data=queryAll(`SELECT t.*,re.id rental_id,r.room_number,COALESCE((SELECT SUM(c.balance) FROM rent_charges c WHERE c.tenant_id=t.id),0) balance FROM tenants t LEFT JOIN rentals re ON re.tenant_id=t.id AND re.status='Active' LEFT JOIN rooms r ON r.id=re.room_id WHERE t.archived=0 ORDER BY t.full_name`);return json(res,200,data);
    }
    if(url.pathname==='/api/tenants'&&req.method==='POST'){
      const d=await body(req);if(!text(d.full_name)||!text(d.phone))return bad(res,'Name and phone are required');const id=uid('ten'),t=nowIso();db.prepare(`INSERT INTO tenants(id,full_name,phone,alternate_phone,email,id_number,emergency_contact_name,emergency_contact_phone,address,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,text(d.full_name),text(d.phone),text(d.alternate_phone),text(d.email),text(d.id_number),text(d.emergency_contact_name),text(d.emergency_contact_phone),text(d.address),text(d.notes),t,t);log('create','tenant',id,`Tenant ${text(d.full_name)} created`);return json(res,201,queryOne('SELECT * FROM tenants WHERE id=?',id));
    }
    if(url.pathname.match(/^\/api\/tenants\/[^/]+$/)&&req.method==='GET'){
      const id=url.pathname.split('/').pop();const tenant=queryOne('SELECT * FROM tenants WHERE id=?',id);if(!tenant)return bad(res,'Tenant not found',404);const rentals=queryAll(`SELECT re.*,r.room_number,r.name room_name FROM rentals re JOIN rooms r ON r.id=re.room_id WHERE re.tenant_id=? ORDER BY re.move_in_date DESC`,id);const payments=queryAll(`SELECT p.*,r.room_number FROM payments p JOIN rooms r ON r.id=p.room_id WHERE p.tenant_id=? ORDER BY p.payment_date DESC`,id);const charges=queryAll('SELECT * FROM rent_charges WHERE tenant_id=? ORDER BY billing_month DESC',id);return json(res,200,{tenant,rentals,payments,charges});
    }
    if(url.pathname.match(/^\/api\/tenants\/[^/]+$/)&&req.method==='PUT'){
      const id=url.pathname.split('/').pop(),d=await body(req),t=queryOne('SELECT * FROM tenants WHERE id=?',id);if(!t)return bad(res,'Tenant not found',404);db.prepare(`UPDATE tenants SET full_name=?,phone=?,alternate_phone=?,email=?,id_number=?,emergency_contact_name=?,emergency_contact_phone=?,address=?,notes=?,updated_at=? WHERE id=?`).run(text(d.full_name)||t.full_name,text(d.phone)||t.phone,text(d.alternate_phone),text(d.email),text(d.id_number),text(d.emergency_contact_name),text(d.emergency_contact_phone),text(d.address),text(d.notes),nowIso(),id);log('update','tenant',id,`Tenant ${text(d.full_name)||t.full_name} updated`);return json(res,200,queryOne('SELECT * FROM tenants WHERE id=?',id));
    }

    if(url.pathname==='/api/rentals'&&req.method==='GET'){
      const data=queryAll(`SELECT re.*,t.full_name,r.room_number,COALESCE((SELECT SUM(c.balance) FROM rent_charges c WHERE c.rental_id=re.id),0) balance FROM rentals re JOIN tenants t ON t.id=re.tenant_id JOIN rooms r ON r.id=re.room_id ORDER BY CASE re.status WHEN 'Active' THEN 0 ELSE 1 END,re.move_in_date DESC`);return json(res,200,data);
    }
    if(url.pathname==='/api/rentals'&&req.method==='POST'){
      const d=await body(req);const room=queryOne('SELECT * FROM rooms WHERE id=?',text(d.room_id)),tenant=queryOne('SELECT * FROM tenants WHERE id=?',text(d.tenant_id));if(!room||!tenant)return bad(res,'Valid tenant and room are required');if(activeRentalForRoom(room.id))return bad(res,'Room already has an active rental');if(room.status==='Maintenance')return bad(res,'Room is under maintenance');const id=uid('rent'),t=nowIso(),rent=int(d.monthly_rent||room.monthly_rent),due=Math.min(28,Math.max(1,int(d.rent_due_day||setting().default_due_day)));db.prepare(`INSERT INTO rentals(id,tenant_id,room_id,move_in_date,monthly_rent,deposit_amount,deposit_received,rent_due_day,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,tenant.id,room.id,text(d.move_in_date)||today(),rent,int(d.deposit_amount),int(d.deposit_received),due,'Active',text(d.notes),t,t);db.prepare("UPDATE rooms SET status='Occupied',updated_at=? WHERE id=?").run(t,room.id);const rental=queryOne('SELECT * FROM rentals WHERE id=?',id);ensureCharge(rental,monthKey(rental.move_in_date));log('create','rental',id,`Rental started: ${tenant.full_name} in ${room.room_number}`);return json(res,201,rental);
    }
    if(url.pathname.match(/^\/api\/rentals\/[^/]+\/end$/)&&req.method==='POST'){
      const id=url.pathname.split('/')[3],d=await body(req),r=queryOne('SELECT re.*,ro.room_number,t.full_name FROM rentals re JOIN rooms ro ON ro.id=re.room_id JOIN tenants t ON t.id=re.tenant_id WHERE re.id=?',id);if(!r)return bad(res,'Rental not found',404);if(r.status!=='Active')return bad(res,'Rental is not active');db.prepare("UPDATE rentals SET status='Ended',move_out_date=?,notes=?,updated_at=? WHERE id=?").run(text(d.move_out_date)||today(),[r.notes,text(d.reason),text(d.notes)].filter(Boolean).join('\n'),nowIso(),id);recalcRoom(r.room_id);log('end','rental',id,`Rental ended: ${r.full_name} from ${r.room_number}`);return json(res,200,{ok:true});
    }

    if(url.pathname==='/api/charges'&&req.method==='GET'){
      const {status='',rental_id=''}=q(url);let sql=`SELECT c.*,t.full_name,r.room_number FROM rent_charges c JOIN tenants t ON t.id=c.tenant_id JOIN rooms r ON r.id=c.room_id WHERE 1=1`,args=[];if(status){sql+=' AND c.status=?';args.push(status)}if(rental_id){sql+=' AND c.rental_id=?';args.push(rental_id)}sql+=' ORDER BY c.billing_month DESC,t.full_name';return json(res,200,queryAll(sql,...args));
    }

    if(url.pathname==='/api/payments'&&req.method==='GET'){
      const data=queryAll(`SELECT p.*,t.full_name,r.room_number,(SELECT group_concat(c.billing_month, ', ') FROM payment_allocations a JOIN rent_charges c ON c.id=a.charge_id WHERE a.payment_id=p.id) periods FROM payments p JOIN tenants t ON t.id=p.tenant_id JOIN rooms r ON r.id=p.room_id ORDER BY p.payment_date DESC,p.created_at DESC`);return json(res,200,data);
    }
    if(url.pathname==='/api/payments'&&req.method==='POST'){
      const d=await body(req);const rental=queryOne('SELECT * FROM rentals WHERE id=?',text(d.rental_id));if(!rental)return bad(res,'Rental is required');const amount=int(d.amount);if(amount<=0)return bad(res,'Amount must be greater than zero');const p={id:uid('pay'),receipt_number:receiptNo(),tenant_id:rental.tenant_id,rental_id:rental.id,room_id:rental.room_id,payment_date:text(d.payment_date)||today(),amount,payment_method:text(d.payment_method)||'Cash',reference:text(d.reference),notes:text(d.notes)};db.exec('BEGIN');try{db.prepare(`INSERT INTO payments(id,receipt_number,tenant_id,rental_id,room_id,payment_date,amount,payment_method,reference,notes,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id,p.receipt_number,p.tenant_id,p.rental_id,p.room_id,p.payment_date,p.amount,p.payment_method,p.reference,p.notes,'Completed',nowIso());allocatePayment(p,text(d.billing_month));log('create','payment',p.id,`Payment ${p.receipt_number} recorded (${amount})`);db.exec('COMMIT')}catch(err){db.exec('ROLLBACK');throw err}return json(res,201,queryOne('SELECT * FROM payments WHERE id=?',p.id));
    }
    if(url.pathname.match(/^\/api\/payments\/[^/]+$/)&&req.method==='GET'){
      const id=url.pathname.split('/').pop();const payment=queryOne(`SELECT p.*,t.full_name,t.phone,r.room_number,re.monthly_rent FROM payments p JOIN tenants t ON t.id=p.tenant_id JOIN rooms r ON r.id=p.room_id JOIN rentals re ON re.id=p.rental_id WHERE p.id=?`,id);if(!payment)return bad(res,'Payment not found',404);const allocations=queryAll(`SELECT a.amount,c.billing_month,c.amount_due,c.balance,c.status FROM payment_allocations a JOIN rent_charges c ON c.id=a.charge_id WHERE a.payment_id=? ORDER BY c.billing_month`,id);const balance=queryOne("SELECT COALESCE(SUM(balance),0) total FROM rent_charges WHERE rental_id=?",payment.rental_id).total;return json(res,200,{payment,allocations,balance,settings:setting()});
    }
    if(url.pathname.match(/^\/api\/payments\/[^/]+\/reverse$/)&&req.method==='POST'){
      const id=url.pathname.split('/')[3],d=await body(req),p=queryOne('SELECT * FROM payments WHERE id=?',id);if(!p)return bad(res,'Payment not found',404);if(p.status==='Reversed')return bad(res,'Payment already reversed');const chargeIds=queryAll('SELECT charge_id FROM payment_allocations WHERE payment_id=?',id).map(x=>x.charge_id);db.prepare("UPDATE payments SET status='Reversed',reversal_reason=?,reversed_at=? WHERE id=?").run(text(d.reason)||'Reversed by administrator',nowIso(),id);for(const c of chargeIds)refreshChargeStatus(c);log('reverse','payment',id,`Payment ${p.receipt_number} reversed: ${text(d.reason)||'No reason given'}`);return json(res,200,{ok:true});
    }

    if(url.pathname==='/api/expenses'&&req.method==='GET')return json(res,200,queryAll('SELECT * FROM expenses ORDER BY expense_date DESC,created_at DESC'));
    if(url.pathname==='/api/expenses'&&req.method==='POST'){
      const d=await body(req),id=uid('exp');if(int(d.amount)<0||!text(d.category))return bad(res,'Category and valid amount are required');db.prepare('INSERT INTO expenses(id,expense_date,category,amount,description,created_at) VALUES(?,?,?,?,?,?)').run(id,text(d.expense_date)||today(),text(d.category),int(d.amount),text(d.description),nowIso());log('create','expense',id,`Expense recorded: ${text(d.category)} (${int(d.amount)})`);return json(res,201,queryOne('SELECT * FROM expenses WHERE id=?',id));
    }

    if(url.pathname==='/api/reports'&&req.method==='GET'){
      const params=q(url),from=params.from||`${monthKey()}-01`,to=params.to||today();
      const collections=queryOne("SELECT COALESCE(SUM(amount),0) total FROM payments WHERE status='Completed' AND payment_date BETWEEN ? AND ?",from,to).total;
      const expenses=queryOne('SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE expense_date BETWEEN ? AND ?',from,to).total;
      const expected=queryOne('SELECT COALESCE(SUM(amount_due),0) total FROM rent_charges WHERE due_date BETWEEN ? AND ?',from,to).total;
      const outstanding=queryOne('SELECT COALESCE(SUM(balance),0) total FROM rent_charges WHERE balance>0').total;
      const overdue=queryAll(`SELECT c.*,t.full_name,t.phone,r.room_number FROM rent_charges c JOIN tenants t ON t.id=c.tenant_id JOIN rooms r ON r.id=c.room_id WHERE c.balance>0 ORDER BY c.due_date ASC`);
      const totalRooms=queryOne('SELECT COUNT(*) c FROM rooms').c,occupied=queryOne("SELECT COUNT(*) c FROM rooms WHERE status='Occupied'").c;
      return json(res,200,{from,to,collections,expenses,net:collections-expenses,expected,outstanding,overdue,totalRooms,occupied,occupancyRate:totalRooms?Math.round(occupied/totalRooms*100):0});
    }
    if(url.pathname==='/api/activity'&&req.method==='GET')return json(res,200,queryAll('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 80'));

    if(url.pathname==='/api/settings'&&req.method==='PUT'){
      const d=await body(req);db.prepare(`UPDATE settings SET business_name=?,phone=?,email=?,address=?,currency=?,default_due_day=?,receipt_prefix=?,logo_url=? WHERE id=1`).run(text(d.business_name)||'Rental Manager',text(d.phone),text(d.email),text(d.address),text(d.currency)||'UGX',Math.min(28,Math.max(1,int(d.default_due_day||5))),text(d.receipt_prefix)||'R',text(d.logo_url));log('update','settings','1','Business settings updated');return json(res,200,setting());
    }
    if(url.pathname==='/api/account/password'&&req.method==='PUT'){
      const d=await body(req),u=queryOne('SELECT * FROM users WHERE id=?',user.id);if(!verifyPassword(String(d.current_password||''),u.password_hash))return bad(res,'Current password is incorrect');if(String(d.new_password||'').length<8)return bad(res,'New password must be at least 8 characters');db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(String(d.new_password)),user.id);return json(res,200,{ok:true});
    }
    return bad(res,'Not found',404);
  }catch(e){console.error(e);return bad(res,e.message?.includes('UNIQUE')?'That record already exists.':(e.message||'Server error'),500);}
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname.startsWith('/api/'))return api(req,res,url);
  if(serveFile(req,res,url))return;
  // SPA fallback
  const fp=join(PUBLIC,'index.html');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(readFileSync(fp));
});
server.listen(PORT,()=>console.log(`Rental Manager running on http://localhost:${PORT}`));
