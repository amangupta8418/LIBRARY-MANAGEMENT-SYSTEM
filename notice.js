async function loadNotices(targetId) {
    const res = await fetch('/api/notices');
    const data = await res.json();
    const container = document.getElementById(targetId);
    if (!container) return;
    container.innerHTML = data.map(n => `
      <div style="background: rgba(0,0,0,0.25); padding: 12px; border-radius: 8px; margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between;">
            <strong>${n.title}</strong>
            <small style="color:var(--text-muted);">${new Date(n.created_at).toLocaleString()}</small>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">${n.message}</p>
      </div>
    `).join('');
}

async function postNotice(title, message) {
    if (!title || !message) return alert('Title aur message dono likhein!');
    await fetch('/api/notices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message })
    });
    alert('Notice broadcasted successfully!');
}