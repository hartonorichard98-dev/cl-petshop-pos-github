# CL Petshop POS

Aplikasi kasir local-first untuk CL Petshop. Data transaksi dan produk disimpan di database browser perangkat, sehingga kasir tetap berjalan saat internet mati.

Target produksi memakai Vercel untuk hosting dan Supabase PostgreSQL/Auth untuk database pusat. Skema awal tersedia di `supabase/migrations/202609190001_initial_schema.sql`; panduan setup tersedia di `DEPLOYMENT.md`.

## Fitur saat ini

- Login terpisah owner/admin dan kasir.
- Kasir, keranjang, pembayaran tunai, dan hitung kembalian.
- Tampilan kasir ringkas: katalog, keranjang, dan pembayaran terlihat dalam satu layar tanpa kartu langkah besar.
- Barang dapat dimasukkan dengan klik, pencarian + Enter, atau perintah suara Bahasa Indonesia.
- Katalog dan hasil pencarian mengutamakan produk yang paling sering muncul dalam transaksi selesai, lalu total quantity terjual.
- Kartu katalog dibuat ringkas; SKU dan barcode disembunyikan dari kartu tetapi tetap tersedia untuk scanner dan menu Produk owner.
- Scanner barcode USB/Bluetooth dapat menambah barang langsung setelah scan + Enter; tombol `F2` memindahkan fokus ke input scanner.
- Scan barcode yang sama berulang kali menambah quantity produk yang sama, bukan membuat baris baru.
- Barcode asli disimpan terpisah dari SKU internal `CL-xxxx` dan hanya dapat direvisi owner.
- Nominal uang memakai pemisah ribuan dan tombol cepat uang pas/Rp10.000–Rp200.000.
- Checkout menyimpan metode pembayaran Tunai, QRIS, Transfer, atau Debit pada setiap transaksi.
- Owner dapat mencatat pengeluaran tunai dari laci lengkap dengan nominal, penerima, keperluan, catatan, waktu, dan pembuat catatan.
- Pengeluaran laci otomatis mengurangi uang yang seharusnya tersedia saat Tutup Kasir.
- Menu Tutup Kasir menghitung pecahan Rp100.000, Rp50.000, Rp20.000, Rp10.000, Rp2.000, Rp1.000, dan Rp500 lalu membandingkan aktual dengan sistem.
- Owner memiliki Log Aktivitas untuk login, transaksi, perubahan produk, void, akses ditolak, dan tutup kasir.
- Paket `2+` dan `3+` dapat digabung antarvarian dalam keluarga, merek, dan ukuran yang sama. Paket `12+`, `24+`, `25+`, dan paket besar lain tetap dihitung per varian.
- Produk bernama `(N+)` dihitung sebagai paket kelipatan N. Sisa barang memakai paket lebih kecil atau harga satuan, bukan seluruh jumlah mendapat harga diskon.
- Kartu katalog mendukung thumbnail 128×128. Owner dapat mengunggah atau memotret produk dari menu revisi data.
- Stok otomatis berkurang setelah transaksi.
- Owner menerima peringatan pesan ulang untuk produk dengan perhitungan stok aktif dan stok tersisa maksimal 12 pcs.
- Owner dapat membuat daftar barang yang akan datang; daftar langsung terlihat oleh kasir pada menu Penerimaan.
- Kasir mencatat quantity fisik yang datang dan wajib memberi keterangan jika berbeda dari pesanan owner.
- Setelah laporan kasir diperiksa, owner dapat menyetujui penerimaan dan stok otomatis bertambah memakai quantity aktual.
- Owner dapat mengembalikan laporan penerimaan kepada kasir jika perlu pemeriksaan ulang.
- Dashboard omzet; HPP dan laba hanya untuk owner.
- Produk dapat ditambah, diedit, diaktifkan, atau dinonaktifkan.
- Revisi harga jual, HPP, dan stok hanya dapat dilakukan oleh owner/admin.
- Database `DATABASE APP KASIR-2.xlsx` diimpor sebagai 336 baris, termasuk HPP asli dan 116 barcode unik; empat barang tanpa harga dinonaktifkan sampai owner mengisinya.
- Owner dapat mengedit transaksi, termasuk jumlah, subtotal, metode pembayaran, uang diterima, dan alasan koreksi.
- Owner dapat melakukan void dengan alasan; stok dikembalikan.
- Penghapusan transaksi memerlukan alasan dan konfirmasi dengan mengetik `HAPUS`; transaksi keluar dari perhitungan tetapi jejak audit tetap disimpan.
- Audit log lokal untuk perubahan penting. Versi produksi tetap membutuhkan backend agar log tidak dapat dimanipulasi lewat browser atau file perangkat.
- PWA installable dan service worker untuk penggunaan offline.
- Transaksi memiliki status sinkronisasi agar siap dihubungkan ke cloud.

## Menjalankan aplikasi

```bash
npm install
npm run dev
```

Build produksi:

```bash
npm run build
npm test
```

## Arsitektur produksi

`kasir-offline.html` adalah entry point produksi. `src/App.tsx` tetap menjadi referensi React dan tidak dipakai oleh halaman produksi. Sinkronisasi aktif tetap memakai `src/cloud-sync.js` agar offline-first dan kompatibel dengan perangkat toko.

Logika cloud baru dipisah ke modul TypeScript di `src/cloud/` untuk tipe data, fingerprint idempotensi, dan normalisasi payload. Modul pure tersebut diuji dengan Vitest; engine produksi lama tetap dipertahankan selama migrasi bertahap agar tidak memutus transaksi.

PIN Supabase divalidasi server-side memakai `crypt(..., gen_salt('bf'))`. Jalur cPanel baru memakai `password_hash`/`password_verify` bcrypt. Browser tidak pernah mengirim hash buatan sendiri sebagai pengganti PIN.

## Akun demo

- Owner: `owner` / `123456`
- Kasir: `kasir` / `1234`

Akun demo wajib diganti sebelum penggunaan produksi.

## Format daftar harga

Daftar barang dapat dikirim dalam Excel, CSV, PDF, foto, atau teks. Data minimum:

| SKU/barcode | Nama barang | Harga jual | Harga modal/HPP | Stok awal |
| --- | --- | ---: | ---: | ---: |
| CL-001 | Contoh makanan kucing | 45000 | 34000 | 20 |

Harga modal diperlukan agar laporan laba benar. Jika stok awal belum tersedia, isi `0` dan lakukan stok opname sebelum toko mulai memakai sistem.

## Batas versi awal

Database offline sudah aktif. Server cloud belum dikonfigurasi, sehingga data berstatus `pending` dan belum terkirim ke perangkat lain. Tahap berikutnya membutuhkan pemilihan server, autentikasi produksi, backup, dan pengujian sinkronisasi dua perangkat.
