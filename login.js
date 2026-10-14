document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            role: document.getElementById('loginRole').value,
            username: document.getElementById('loginUsername').value.trim(),
            password: document.getElementById('loginPassword').value
        })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error);
    sessionStorage.setItem('lms_user', JSON.stringify(data));
    window.location.href = data.redirect;
};