// Gửi thông báo hạn dùng hằng ngày qua Firebase Cloud Messaging (chạy bằng GitHub Actions)
const admin = require('firebase-admin');

const SITE_URL = process.env.SITE_URL || 'https://tiendz1.github.io/fresh-track/';
const TZ = process.env.APP_TZ_OFFSET || '+07:00';                 // múi giờ của hạn dùng đã nhập (Việt Nam = +07:00)
const FORCE = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';   // bấm "Run workflow" thủ công: luôn gửi, bỏ qua kiểm tra trùng

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error('THIẾU secret FIREBASE_SERVICE_ACCOUNT. Vào repo > Settings > Secrets and variables > Actions để thêm.');
    process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const messaging = admin.messaging();

// Hạn lưu dạng "YYYY-MM-DDTHH:mm" (giờ địa phương) -> mili giây
const toMs = s => Date.parse(String(s).length === 16 ? `${s}:00${TZ}` : String(s));
const tzMin = (() => { const m = TZ.match(/([+-])(\d\d):(\d\d)/); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 420; })();
const dayKey = new Date(Date.now() + tzMin * 60000).toISOString().slice(0, 10);   // ngày hiện tại theo giờ Việt Nam

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
    console.log(`Ngày (giờ VN): ${dayKey} | chế độ: ${FORCE ? 'chạy thủ công (bỏ qua kiểm tra trùng)' : 'theo lịch'}`);
    const tokenSnap = await db.collection('pushTokens').get();
    if (tokenSnap.empty) { console.log('Chưa có thiết bị nào đăng ký nhận thông báo (collection pushTokens trống).'); return; }

    const ids = [...new Set(tokenSnap.docs.flatMap(d => d.data().ids || []))];
    const products = {};
    for (let i = 0; i < ids.length; i += 300) {
        const refs = ids.slice(i, i + 300).map(id => db.collection('products').doc(id));
        (await db.getAll(...refs)).forEach(s => { if (s.exists && s.data().status !== 'pending') products[s.id] = s.data(); });
    }

    const messages = [], docIds = [];
    let skippedSent = 0, skippedEmpty = 0;
    tokenSnap.docs.forEach(doc => {
        const data = doc.data();
        if (!FORCE && data.lastSent === dayKey) { skippedSent++; return; }       // hôm nay đã gửi rồi (lần chạy dự phòng)
        const tracked = (data.ids || []).filter(id => products[id]);
        if (!tracked.length) { skippedEmpty++; return; }
        const hits = tracked.map(id => ({ id, p: products[id], lvl: level(products[id], now) }))
            .filter(h => h.lvl > 0).sort((a, b) => b.lvl - a.lvl);

        let title, body, url = SITE_URL;
        if (hits.length) {
            const c = l => hits.filter(h => h.lvl === l).length;
            const parts = [];
            if (c(3)) parts.push(`${c(3)} đã hết hạn`);
            if (c(2)) parts.push(`${c(2)} còn dưới 24 giờ`);
            if (c(1)) parts.push(`${c(1)} nên dùng ngay`);
            title = 'ChromaTech: cần chú ý hạn dùng';
            body = `${parts.join(' · ')}\n${hits.slice(0, 3).map(h => h.p.name).join(', ')}${hits.length > 3 ? '…' : ''}`;
            if (hits.length === 1) url = `${SITE_URL}?id=${encodeURIComponent(hits[0].id)}`;
        } else {
            title = 'ChromaTech: chào buổi sáng ☀️';
            body = `Bạn đang theo dõi ${tracked.length} sản phẩm, hôm nay chưa có sản phẩm nào cần chú ý.`;
        }
        messages.push({
            token: data.token || doc.id,
            data: { title, body, url, tag: 'chromatech-daily' },
            webpush: { headers: { Urgency: 'high', TTL: '43200' } }
        });
        docIds.push(doc.id);
    });

    console.log(`Thiết bị đăng ký: ${tokenSnap.size} | cần gửi: ${messages.length} | đã gửi hôm nay: ${skippedSent} | chưa theo dõi sản phẩm nào: ${skippedEmpty}`);
    let sent = 0;
    const dead = [], okIds = [];
    for (let i = 0; i < messages.length; i += 500) {
        const batch = messages.slice(i, i + 500);
        const res = await messaging.sendEach(batch);
        res.responses.forEach((r, k) => {
            if (r.success) { sent++; okIds.push(docIds[i + k]); return; }
            const code = r.error && r.error.code;
            console.log('Gửi lỗi:', code, '-', r.error && r.error.message);
            if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'].includes(code)) dead.push(docIds[i + k]);
        });
    }
    await Promise.all(okIds.map(id => db.collection('pushTokens').doc(id).update({ lastSent: dayKey })));
    await Promise.all(dead.map(id => db.collection('pushTokens').doc(id).delete()));   // dọn token hết hiệu lực
    console.log(`Đã gửi thành công: ${sent} | token hết hạn đã dọn: ${dead.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
