const form = document.querySelector('#consultation-form');
const status = document.querySelector('#form-status');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true; button.textContent = '送信しています…'; status.textContent = '';
  const data = Object.fromEntries(new FormData(form)); data.consent = form.elements.consent.checked;
  try {
    const response = await fetch('/api/consultations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    form.reset(); status.textContent = 'お申込みありがとうございます。受付が完了しました。通常2営業日以内にメールで日程をご相談します。'; status.className = 'success';
  } catch (error) { status.textContent = error.message || '通信に失敗しました。時間をおいてお試しください。'; status.className = 'error'; }
  finally { button.disabled = false; button.innerHTML = '無料相談を申し込む <span>↗</span>'; }
});
