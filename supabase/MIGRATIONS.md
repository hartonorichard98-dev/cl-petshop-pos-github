# Kebijakan migration produksi

- Migration yang sudah pernah dijalankan tidak diubah atau digabung ulang karena checksum dan urutan produksi harus tetap konsisten.
- Data bootstrap besar disimpan di `supabase/seed.sql` atau script import khusus, bukan ditambahkan ke migration skema baru.
- Folder `supabase/legacy-migrations/` menyimpan patch lama yang tidak lagi menjadi jalur utama instalasi baru.
- Perubahan skema berikutnya harus kecil, idempotent bila memungkinkan, dan tidak menghapus histori transaksi.
- Sebelum reset atau import produksi: backup, hitung jumlah transaksi/status/omzet, jalankan import idempotent, lalu cocokkan ulang hasilnya.

