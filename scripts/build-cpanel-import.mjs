import bcrypt from 'bcryptjs'
import fs from 'node:fs'
import path from 'node:path'

const salesPath = process.argv[2] || '/tmp/cl-pos-production-sales-2026.json'
const snapshotPath = process.argv[3] || '/tmp/cl-pos-production-snapshot.json'
const outputPath = process.argv[4] || 'cpanel/database/import-production.sql'
const salesExport = JSON.parse(fs.readFileSync(salesPath, 'utf8'))
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
const sales = Array.isArray(salesExport.sales) ? salesExport.sales : []

function sqlString(value) {
  if (value === null || value === undefined || value === '') return 'NULL'
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
}

function jsonValue(value) {
  return sqlString(JSON.stringify(value))
}

function mysqlDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '1970-01-01 00:00:00.000000'
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

function hashPin(pin) {
  return bcrypt.hashSync(pin, 12)
}

function chunks(values, size = 150) {
  const result = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function insertRows(table, columns, rows, updateColumns = columns) {
  if (!rows.length) return ''
  return chunks(rows).map(group => {
    const values = group.map(row => `(${row.join(',')})`).join(',\n')
    const updates = updateColumns.map(column => `${column}=VALUES(${column})`).join(',')
    return `INSERT INTO ${table} (${columns.join(',')}) VALUES\n${values}\nON DUPLICATE KEY UPDATE ${updates};`
  }).join('\n\n')
}

const output = [
  '-- CL Petshop production import generated ' + new Date().toISOString(),
  'SET NAMES utf8mb4;',
  'SET time_zone = \'+00:00\';',
  'SET FOREIGN_KEY_CHECKS = 0;',
  `INSERT INTO pos_staff (username,display_name,role,pin_hash,active) VALUES
('owner','Owner CL Petshop','owner','${hashPin('123456')}',1),
('kasir','Kasir CL Petshop','cashier','${hashPin('1234')}',1)
ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),role=VALUES(role),pin_hash=VALUES(pin_hash),active=VALUES(active);`,
  insertRows('sales', ['id','receipt_number','cashier_name','business_date','created_at','updated_at','status','total','cost_total','payment_method','payload'], sales.map(row => [
    sqlString(row.id), sqlString(row.receipt_number), sqlString(row.cashier_name), sqlString(row.business_date), sqlString(mysqlDate(row.created_at)), sqlString(mysqlDate(row.updated_at || row.created_at)), sqlString(row.status || 'completed'), Number(row.total) || 0, row.cost_total === null ? 'NULL' : Number(row.cost_total) || 0, sqlString(row.payment_method || 'cash'), jsonValue(row),
  ])),
  insertRows('expenses', ['id','business_date','created_at','updated_at','status','amount','payload'], (snapshot.expenses || []).map(row => [sqlString(row.id),sqlString(row.business_date),sqlString(mysqlDate(row.created_at)),sqlString(mysqlDate(row.updated_at||row.created_at)),sqlString(row.status||'active'),Number(row.amount)||0,jsonValue(row)])),
  insertRows('products', ['local_id','sku','stock','track_stock','updated_at','payload'], (snapshot.inventory_products || []).map(row => [Number(row.local_id)||0,sqlString(row.sku),Number(row.stock)||0,row.track_stock?1:0,sqlString(mysqlDate(row.updated_at)),jsonValue(row)])),
  insertRows('inventory_movements', ['id','created_at','updated_at','status','payload'], (snapshot.inventory_movements || []).map(row => [sqlString(row.id),sqlString(mysqlDate(row.created_at)),sqlString(mysqlDate(row.updated_at||row.created_at)),sqlString(row.status||'active'),jsonValue(row)])),
  insertRows('inventory_change_requests', ['id','requested_at','updated_at','status','payload'], (snapshot.inventory_change_requests || []).map(row => [sqlString(row.id),sqlString(mysqlDate(row.requested_at)),sqlString(mysqlDate(row.updated_at||row.requested_at)),sqlString(row.status||'pending'),jsonValue(row)])),
  insertRows('receivings', ['id','receiving_number','created_at','updated_at','deleted_at','status','payload'], (snapshot.receivings || []).map(row => [sqlString(row.id),sqlString(row.receiving_number),sqlString(mysqlDate(row.created_at)),sqlString(mysqlDate(row.updated_at||row.created_at)),row.deleted_at?sqlString(mysqlDate(row.deleted_at)):'NULL',sqlString(row.status||'waiting_check'),jsonValue(row)])),
  insertRows('audit_logs', ['id','created_at','payload'], (snapshot.audit_logs || []).map(row => [sqlString(row.id),sqlString(mysqlDate(row.created_at)),jsonValue(row)])),
  insertRows('sale_deletions', ['sale_id','deleted_at'], (snapshot.deleted_ids || []).map(id => [sqlString(id),sqlString(mysqlDate(snapshot.sync_cursor))])),
  'SET FOREIGN_KEY_CHECKS = 1;',
].filter(Boolean).join('\n\n') + '\n'

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, output)
console.log(JSON.stringify({ outputPath, bytes: Buffer.byteLength(output), sales: sales.length, products: snapshot.inventory_products?.length || 0, movements: snapshot.inventory_movements?.length || 0, receivings: snapshot.receivings?.length || 0 }))
