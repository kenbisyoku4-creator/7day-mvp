const form = document.querySelector('#consultation-form');
const status = document.querySelector('#form-status');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true; button.textContent = '送信しています…'; status.textContent = '';
  const data = Object.fromEntries(new FormData(form)); data.consent = form.elements.consent.checked;
  try {
    const response = await fetch('/api/consultations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('サーバーからの応答を確認できませんでした。入力内容は残っています。時間をおいて再度お試しください。'); }
    if (!response.ok) throw new Error(result.error || '送信できませんでした。時間をおいて再度お試しください。');
    form.reset(); status.textContent = 'お申込みありがとうございます。受付が完了しました。通常2営業日以内にメールで日程をご相談します。'; status.className = 'success';
  } catch (error) { status.textContent = error instanceof TypeError ? '通信に失敗しました。接続をご確認のうえ、再度お試しください。入力内容は残っています。' : error.message || '送信できませんでした。時間をおいて再度お試しください。'; status.className = 'error'; }
  finally { button.disabled = false; button.innerHTML = '無料相談に申し込む <span>↗</span>'; }
});
