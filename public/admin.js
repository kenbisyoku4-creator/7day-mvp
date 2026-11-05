const status = document.querySelector('#admin-status');
async function load() {
  document.querySelector('#applications').replaceChildren();
  status.textContent = '読み込み中…';
  try {
    const response = await fetch('/api/applications', { cache: 'no-store' });
    if (!response.ok) throw new Error('一覧を取得できませんでした。認証と接続をご確認ください。');
    const { applications } = await response.json();
    const list = document.querySelector('#applications'); list.replaceChildren();
    for (const row of applications) {
      const card = document.createElement('article'); card.className = 'application';
      for (const [label, value] of [['受付番号', row.id], ['受付日時', new Date(row.created_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })], ['お名前', row.name], ['メール', row.email], ['希望時間帯', row.preference], ['相談内容', row.message || '記入なし']]) {
        const p = document.createElement('p'); const strong = document.createElement('strong'); strong.textContent = label + '： '; p.append(strong, document.createTextNode(value)); card.append(p);
      }
      list.append(card);
    }
    status.textContent = applications.length ? `${applications.length}件の申込` : 'まだ申込はありません。';
  } catch (error) { status.textContent = error.message; }
}
document.querySelector('#reload').addEventListener('click', load); load();
