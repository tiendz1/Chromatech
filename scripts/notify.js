// Gửi thông báo hạn dùng hằng ngày qua Firebase Cloud Messaging (chạy bằng GitHub Actions)
const admin = require('firebase-admin');

const SITE_URL = process.env.SITE_URL || 'https://tiendz1.github.io/fresh-track/';
const TZ = process.env.APP_TZ_OFFSET || '+07:00';   // múi giờ của hạn dùng đã nhập (Việt Nam = +07:00)

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const messaging = admin.messaging();

// Hạn lưu dạng "YYYY-MM-DDTHH:mm" (giờ địa phương) -> mili giây
const toMs = s => Date.parse(String(s).length === 16 ? `${s}:00${TZ}` : String(s));

// 3 = đã hết hạn, 2 = còn dưới 24 giờ, 1 = quá hạn ngon nhất (nên dùng ngay)
function level(p, now) {
    const exp = toMs(p.expiry), bb = toMs(p.bestBefore);
    if (isNaN(exp)) return 0;
    if (now > exp) return 3;
    if (exp - now <= 864e5) return 2;
    return (!isNaN(bb) && now > bb) ? 1 : 0;
}

async function main() {
    const now = Date.now();
    const tokenSnap = await db.collection('pushTokens').get();
    if (tokenSnap.empty) { console.log('Chưa có thiết bị nào đăng ký nhận thông báo.'); return; }

    const ids = [...new Set(tokenSnap.docs.flatMap(d => d.data().ids || []))];
    const products = {};
    for (let i = 0; i < ids.length; i += 300) {
        const refs = ids.slice(i, i + 300).map(id => db.collection('products').doc(id));
        (await db.getAll(...refs)).forEach(s => { if (s.exists && s.data().status !== 'pending') products[s.id] = s.data(); });
    }

    const messages = [];
    tokenSnap.docs.forEach(doc => {
        const data = doc.data();
        const hits = (data.ids || [])
            .filter(id => products[id])
            .map(id => ({ id, p: products[id], lvl: level(products[id], now) }))
            .filter(h => h.lvl > 0)
            .sort((a, b) => b.lvl - a.lvl);
        if (!hits.length) return;
        const c = l => hits.filter(h => h.lvl === l).length;
        const parts = [];
        if (c(3)) parts.push(`${c(3)} đã hết hạn`);
        if (c(2)) parts.push(`${c(2)} còn dưới 24 giờ`);
        if (c(1)) parts.push(`${c(1)} nên dùng ngay`);
        const names = hits.slice(0, 3).map(h => h.p.name).join(', ') + (hits.length > 3 ? '…' : '');
        messages.push({
            token: data.token || doc.id,
            data: {
                title: 'ChromaTech: cần chú ý hạn dùng',
                body: `${parts.join(' · ')}\n${names}`,
                url: hits.length === 1 ? `${SITE_URL}?id=${encodeURIComponent(hits[0].id)}` : SITE_URL,
                tag: 'chromatech-daily'
            },
            webpush: { headers: { Urgency: 'high', TTL: '86400' } }
        });
    });

    console.log(`Thiết bị đăng ký: ${tokenSnap.size} | cần gửi thông báo: ${messages.length}`);
    let sent = 0;
    const dead = [];
    for (let i = 0; i < messages.length; i += 500) {
        const batch = messages.slice(i, i + 500);
        const res = await messaging.sendEach(batch);
        res.responses.forEach((r, k) => {
            if (r.success) { sent++; return; }
            const code = r.error && r.error.code;
            console.log('Gửi lỗi:', code);
            if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'].includes(code)) dead.push(batch[k].token);
        });
    }
    // Dọn token đã hết hiệu lực (người dùng gỡ ứng dụng / thu hồi quyền)
    await Promise.all(dead.map(t => db.collection('pushTokens').doc(t).delete()));
    console.log(`Đã gửi: ${sent} | token hết hạn đã dọn: ${dead.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
