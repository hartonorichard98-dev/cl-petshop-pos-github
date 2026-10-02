import fs from 'node:fs'

const pepper = process.env.CL_POS_PIN_PEPPER
if (!pepper || pepper.length < 32) throw new Error('CL_POS_PIN_PEPPER minimal 32 karakter')

const config = `<?php
return [
    'dsn' => 'mysql:host=localhost;dbname=clpetsho_clpos;charset=utf8mb4',
    'user' => 'clpetsho_clposapp',
    'password' => '__DB_PASSWORD__',
    'pin_pepper' => '${pepper}',
];
`

fs.writeFileSync('cpanel/api/config.php', config, { mode: 0o600 })
