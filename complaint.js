async function sendComplaint(studentId, text) {
    if (!text) return alert('Kripya apni complaint details likhein!');
    await fetch('/api/complaints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id: studentId, message: text })
    });
    alert('Aapki grievance direct Admin Control Desk par submit ho gayi hai!');
}

async function loadAdminComplaints(targetId) {
    const res = await fetch('/api/complaints');
    const data = await res.json();
    const container = document.getElementById(targetId);
    if (!container) return;
    container.innerHTML = data.map(c => `
      <div style="display:flex; justify-content:space-between; align-items:center; background: rgba(0,0,0,0.25); padding: 12px; border-radius: 8px; margin-bottom: 8px;">
        <div>
            <strong style="color:#00d2ff;">${c.student_id}:</strong> ${c.message}
            <small style="display:block; color:var(--text-muted);">${new Date(c.created_at).toLocaleString()}</small>
        </div>
        <button class="btn btn-danger" style="padding: 5px 10px; font-size: 11px;" onclick="purgeComplaint(${c.id})">Resolve & Purge</button>
      </div>
    `).join('');
}

async function purgeComplaint(id) {
    await fetch(`/api/complaints/${id}`, { method: 'DELETE' });
    loadAdminComplaints('complaintBox');
}