import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(projectRoot, 'price-list-data.js')
const destination = resolve(projectRoot, 'public', 'price-list-data.js')

await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)

console.log('Price list copied to public/price-list-data.js')
