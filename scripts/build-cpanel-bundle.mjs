import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const output = path.join(root, 'deployment', 'cl-petshop-cpanel')
fs.rmSync(output, { recursive: true, force: true })
fs.mkdirSync(output, { recursive: true })
fs.cpSync(path.join(root, 'dist'), output, { recursive: true })
fs.copyFileSync(path.join(root, 'pos-responsive.css'), path.join(output, 'pos-responsive.css'))
fs.mkdirSync(path.join(output, 'src'), { recursive: true })
fs.copyFileSync(path.join(root, 'src', 'cloud-sync.js'), path.join(output, 'src', 'cloud-sync.js'))
fs.cpSync(path.join(root, 'cpanel', 'api'), path.join(output, 'api'), { recursive: true })
fs.copyFileSync(path.join(root, 'cpanel', '.htaccess'), path.join(output, '.htaccess'))
fs.mkdirSync(path.join(output, 'database'), { recursive: true })
fs.copyFileSync(path.join(root, 'cpanel', 'database', '.htaccess'), path.join(output, 'database', '.htaccess'))
fs.copyFileSync(path.join(root, 'cpanel', 'database', 'schema.sql'), path.join(output, 'database', 'schema.sql'))
fs.copyFileSync(path.join(root, 'cpanel', 'database', 'import-production.sql'), path.join(output, 'database', 'import-production.sql'))
console.log(output)
