# OfficeDesk: remote desktop khusus kantor

Aplikasi remote desktop internal yang:

- **hanya bisa dipakai pemilik email kantor**: login dengan kode 6 angka yang dikirim ke email `@domain-kantor`, email lain ditolak;
- **lintas OS**: Windows, macOS, dan Linux, masing-masing bisa me-remote dan di-remote;
- **lintas jaringan**: perangkat di rumah, kantor, atau hotspot HP tetap bisa tersambung (langsung P2P bila bisa, lewat relay TURN bila tidak).

```
[Penonton] ══ WebRTC P2P, terenkripsi DTLS-SRTP (video + input) ══ [Host]
     └──────────── HTTPS + WebSocket (login & perkenalan) ───────────┘
                                [Server]  ←→  [Relay TURN, bila NAT ketat]
```

Gambar layar dan input tidak pernah lewat server aplikasi. Server hanya mengurus login, daftar perangkat, "perkenalan" kedua perangkat (signaling), kredensial TURN sementara, dan log audit.

## Struktur

| Folder | Isi |
| --- | --- |
| `server/` | Node 24 + TypeScript (dijalankan langsung, tanpa build), SQLite bawaan Node. Login OTP, perangkat, signaling, TURN, audit. |
| `desktop/` | Aplikasi Electron. Tangkap layar via WebRTC, input lewat [koffi](https://koffi.dev) ke API OS (Windows `SendInput`, macOS CoreGraphics, Linux XTest). |
| `deploy/` | `docker-compose.yml` untuk satu VPS: server + Caddy (HTTPS otomatis) + coturn (relay TURN). |

## Aturan akses

1. **Login**: email harus persis berdomain di `ALLOWED_EMAIL_DOMAINS` (`a@kantor.co.id.evil.com` dan `a@sub.kantor.co.id` ditolak). Kode berlaku 10 menit, maks 5 kali salah, dibatasi per email dan per IP. Kode disimpan dalam bentuk hash.
2. **Sesi**: token acak, disimpan di server dalam bentuk hash (bisa dicabut lewat Keluar atau Hapus perangkat), dan di komputer dienkripsi dengan keychain OS. Halaman aplikasi tidak pernah melihat token.
3. **Perangkat**: tiap instalasi mendapat ID 9 angka plus kunci rahasia, sehingga ID tidak bisa "dibajak" instalasi lain.
4. **Menyambung**:
   - ke perangkat **akun sendiri** → langsung tersambung, misalnya me-remote PC kantor dari rumah. Bisa dimatikan di perangkat host ("Akun saya sendiri boleh masuk tanpa konfirmasi");
   - ke perangkat **rekan** → rekan harus menekan **Izinkan** atau **Izinkan lihat saja**.
5. **Selama sesi**, host melihat banner merah "Dikendalikan oleh …" yang selalu di atas, dengan tombol **Putuskan**. Pada mode lihat saja, input tidak diteruskan (dicek ulang di proses utama).
6. **Audit**: login, permintaan, mulai/selesai sesi (dengan durasi dan siapa yang memutus) tercatat dan bisa dilihat di "Riwayat akses".

## Mencoba di satu komputer

```bash
cd remote-desktop/server && npm install
ALLOWED_EMAIL_DOMAINS=kantor.test npm start      # tanpa SMTP: kode login dicetak di konsol ini
```

Di terminal lain, jalankan dua salinan aplikasi dengan profil terpisah:

```bash
cd remote-desktop/desktop && npm install
OFFICEDESK_PROFILE=a npm start
```

```bash
cd remote-desktop/desktop && OFFICEDESK_PROFILE=b npm start
```

Masuk dengan dua email `@kantor.test` berbeda, lalu ketik ID salah satunya di salinan lainnya.

Untuk menguji tanpa izin perekaman layar atau tanpa menggerakkan mouse sungguhan, ada dua saklar khusus pengembangan:
`OFFICEDESK_FAKE_CAPTURE=1` (mengirim gambar uji, bukan layar asli) dan `OFFICEDESK_FAKE_INPUT=1` (input hanya dicatat ke log).

Tes server: `cd server && npm test && npm run typecheck`. Cek runtime desktop: `cd desktop && npm run check`. Cek ini memuat koffi di Electron dan mengikat fungsi input OS tanpa mengirim input apa pun.

## Deploy ke VPS

Butuh satu VPS ber-IP publik (1 vCPU / 1 GB cukup), Docker, dan dua subdomain yang mengarah ke VPS (mis. `desk.kantor.co.id` dan `turn.kantor.co.id`).

```bash
cd remote-desktop/deploy
cp .env.example .env        # isi domain, IP publik, SMTP mailbox kantor, dan TURN_SECRET (openssl rand -hex 32)
docker compose up -d --build
```

Buka di firewall VPS: TCP 80 dan 443 (HTTPS), TCP+UDP 8443 (TURN), serta UDP 49160–49360 (relay).

**SMTP dari cPanel**: buat mailbox mis. `noreply@kantor.co.id`, lalu ambil host/port dari *Email Accounts → Connect Devices* (biasanya `mail.kantor.co.id`, port 465 SSL).

## Build installer

Sebelum build untuk karyawan, ubah `desktop/config.json`:

```json
{ "serverUrl": "https://desk.kantor.co.id", "lockServerUrl": true }
```

`lockServerUrl` menyembunyikan isian server di layar login, sehingga aplikasi tidak bisa diarahkan ke server lain.

```bash
cd remote-desktop/desktop
npm run dist:mac      # .dmg + .zip (arm64 & x64), harus di Mac
npm run dist:win      # installer NSIS .exe, paling mudah di Windows
npm run dist:linux    # AppImage + .deb
```

Atau jalankan workflow GitHub Actions **Remote desktop (OfficeDesk)**: tes server, lalu build di Windows, macOS, dan Linux, dan hasilnya bisa diunduh di tab *Artifacts*.

Build belum ditandatangani (code signing). Di Windows, SmartScreen akan memperingatkan saat pertama kali dijalankan (*More info → Run anyway*). Di Mac, klik kanan → Open, atau jalankan `xattr -cr /Applications/OfficeDesk.app`.

## Izin per OS

| OS | Agar bisa **dilihat** | Agar bisa **dikendalikan** |
| --- | --- | --- |
| Windows 10/11 | — | — (jendela "Run as administrator" milik aplikasi lain tidak bisa dikendalikan, kecuali OfficeDesk juga dijalankan sebagai admin) |
| macOS 13+ | Pengaturan Sistem → Privasi & Keamanan → **Perekaman Layar** | … → **Aksesibilitas** |
| Linux | Xorg: langsung. Wayland: muncul dialog berbagi layar | Hanya sesi **Xorg** (X11). Di Wayland otomatis jadi "lihat saja" |

Aplikasi menampilkan peringatan dan tombol "Buka Pengaturan" bila izin macOS belum diberikan.

## Belum termasuk (tahap berikutnya)

- Akses sebelum ada yang login ke OS / layar UAC Windows (butuh service level sistem).
- Kendali di Linux Wayland.
- Sinkron clipboard, transfer file, suara.
- Ikon tray / jalan di latar belakang saat jendela ditutup. Saat ini menutup jendela = aplikasi berhenti dan perangkat offline.
- Panel admin untuk melihat semua perangkat & audit seluruh kantor.
- Code signing / notarisasi.

## Referensi

Arsitektur (Electron + WebRTC + signaling + coturn) mengikuti pendekatan yang sudah terbukti di [TryDesk](https://github.com/latiefahmad/trydesk), tetapi kodenya ditulis ulang. Tidak ada kode yang disalin, sehingga proyek ini tidak terikat lisensi AGPL-3.0 TryDesk. Perbedaan utamanya: login email kantor, host di ketiga OS (TryDesk hanya Windows), dan log audit.
