# Deployment CL Petshop POS

## Arsitektur

- Vercel: hosting aplikasi PWA.
- Supabase PostgreSQL: produk, transaksi, penerimaan, tutup kasir, pengeluaran, dan audit log.
- Supabase Auth: akun individual owner dan kasir. PIN demo lokal tidak boleh dipakai untuk produksi.
- Browser local storage/IndexedDB: cache offline dan antrean sinkronisasi saat internet mati.

## Variabel Vercel

Salin nilai dari Supabase Project Settings → API:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_STORE_ID
```

`VITE_SUPABASE_ANON_KEY` boleh digunakan di browser karena keamanan tetap dijaga oleh Row Level Security. Jangan pernah memasukkan `service_role` key ke Vercel frontend atau repository.

## Langkah Supabase

1. Buat project Supabase di region terdekat dari toko.
2. Jalankan migration `supabase/migrations/202609190001_initial_schema.sql`.
3. Buat akun owner melalui Supabase Auth.
4. Login sebagai owner lalu panggil RPC `bootstrap_store('CL Petshop', 'Owner CL Petshop')` satu kali.
5. Simpan UUID toko hasil RPC sebagai `VITE_STORE_ID` di Vercel.
6. Buat akun kasir, lalu owner menambahkan user tersebut ke `store_members` dengan role `cashier`.

## Langkah Vercel

1. Import repository GitHub `hartonorichard98-dev/cl-petshop-pos-github`.
2. Framework preset: Vite.
3. Build command: `npm run build`.
4. Output directory: `dist`.
5. Tambahkan tiga environment variables di atas untuk Production dan Preview.
6. Deploy ulang setelah variabel tersimpan.

## Catatan keamanan

- Ganti akun demo sebelum penggunaan produksi.
- Setiap kasir harus memiliki akun sendiri agar audit log jelas.
- Aktifkan backup Supabase dan MFA untuk akun owner.
- Jangan menaruh password, access token, atau `service_role` key dalam Git.

