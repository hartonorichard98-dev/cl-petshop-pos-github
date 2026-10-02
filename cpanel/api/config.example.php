<?php
return [
    'dsn' => 'mysql:host=localhost;dbname=CPANEL_DATABASE;charset=utf8mb4',
    'user' => 'CPANEL_DATABASE_USER',
    'password' => 'CPANEL_DATABASE_PASSWORD',
    // Optional only for legacy SHA-256 rows. New imports use bcrypt.
    'pin_pepper' => '',
];
