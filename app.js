const user = JSON.parse(sessionStorage.getItem('lms_user') || '{}');
if (!user.student_id) window.location.href = 'index.html';

async function loadProfile() {
    const res = await fetch(`/api/student/profile/${user.student_id}`);
    const data = await res.json();
    document.getElementById('pName').innerText = data.name;
    document.getElementById('pId').innerText = `ID: ${data.student_id}`;
    document.getElementById('pEmail').innerText = data.email;
    document.getElementById('pMobile').innerText = data.mobile;
    document.getElementById('pAddress').innerText = data.address || 'Bareilly, UP';
    document.getElementById('pExpiry').innerText = data.membership_expiry ? new Date(data.membership_expiry).toLocaleDateString() : 'Active';
    if (data.profile_pic && data.profile_pic !== 'default.png') {
        document.getElementById('avatarDisplay').src = `/uploads/${data.profile_pic}`;
    }
}

async function uploadPhoto() {
    const file = document.getElementById('photoInput').files[0];
    if (!file) return alert('Photo select karein!');
    if (file.size > 2 * 1024 * 1024) return alert('Strict: Photo size 2MB se kam hona chahiye!');

    const fd = new FormData();
    fd.append('profile_pic', file);
    fd.append('student_id', user.student_id);

    const res = await fetch('/api/student/upload-photo', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.success) {
        document.getElementById('avatarDisplay').src = `/uploads/${data.filename}`;
        alert('Photo safely uploaded (Under 2MB)!');
    }
}

async function loadStudentData() {
    // 1. My Issued Books & Fine
    const bRes = await fetch(`/api/student/my-books/${user.student_id}`);
    const myBooks = await bRes.json();
    document.getElementById('myIssuedTbody').innerHTML = myBooks.length === 0 
      ? `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">Aapke paas koi active issued book nahi hai.</td></tr>`
      : myBooks.map(b => `
        <tr>
          <td><img src="${b.cover_image}" class="book-cover"></td>
          <td><strong>${b.title}</strong><br><small style="color:var(--text-muted);">${b.author}</small></td>
          <td><span class="badge ${b.status === 'ISSUED' ? 'badge-issued' : 'badge-fifo'}">${b.status}</span></td>
          <td><small>${b.issue_date ? new Date(b.issue_date).toLocaleString() : '--'}</small></td>
          <td><small>${b.return_date ? new Date(b.return_date).toLocaleString() : 'Not Returned Yet'}</small></td>
          <td>
            ${b.calculated_fine > 0 
              ? `<span style="color:#ff3b30; font-weight:700;">₹${b.calculated_fine}</span> <button class="btn btn-warning" style="padding:3px 8px; font-size:10px; margin-left:6px;" onclick="payFine(${b.id},${b.calculated_fine})">Pay Fine</button>` 
              : `<span style="color:#4cd964; font-weight:700;">₹0</span>`}
          </td>
          <td>
            ${b.status === 'ISSUED' ? `<button class="btn btn-danger" style="padding: 5px 10px; font-size:11px;" onclick="returnBook(${b.id}, '${b.book_id}')">Return Book</button>` : 'Completed'}
          </td>
        </tr>
      `).join('');

    // 2. Catalog (10 Books)
    const cRes = await fetch('/api/books');
    renderCatalog(await cRes.json());

    // 3. Notices
    loadNotices('noticeContainer');
    loadProfile();
    loadMyGrievanceReplies();
}

function renderCatalog(books) {
    document.getElementById('catalogTbody').innerHTML = books.map(b => `
      <tr>
        <td><img src="${b.cover_image}" class="book-cover"></td>
        <td><strong>${b.book_id}</strong></td>
        <td>${b.title}</td>
        <td>${b.author}</td>
        <td><span class="badge" style="background:rgba(255,255,255,0.1);">${b.category || 'CS'}</span></td>
        <td>${b.available_copies > 0 ? `<span class="badge badge-issued">${b.available_copies} Left</span>` : `<span class="badge badge-fifo">0 Left (Waitlist)</span>`}</td>
        <td>
          <button class="btn btn-primary" style="padding: 5px 10px; font-size:11px;" onclick="issueBook('${b.book_id}')">
            ${b.available_copies > 0 ? 'Issue Book' : 'Enter FIFO Queue'}
          </button>
        </td>
      </tr>
    `).join('');
}

async function issueBook(book_id) {
    const res = await fetch('/api/books/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id: user.student_id, book_id })
    });
    const d = await res.json();
    alert(d.message);
    loadStudentData();
}

async function returnBook(tx_id, book_id) {
    if (!confirm('Kya aap is book ko return karna chahte hain?')) return;
    const res = await fetch('/api/books/return', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: tx_id, book_id })
    });
    const d = await res.json();
    alert(d.message);
    loadStudentData();
}

async function payFine(tx_id, amount) {
    if (!confirm(`Clear ₹${amount} fine amount?`)) return;
    const res = await fetch('/api/student/pay-fine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: tx_id, amount })
    });
    const d = await res.json();
    alert(d.message);
    loadStudentData();
}

async function requestMembership(days) {
    const res = await fetch('/api/student/request-membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id: user.student_id, days })
    });
    const d = await res.json();
    alert(d.message);
}

function submitComplaint() {
    const text = document.getElementById('complaintMsg').value.trim();
    sendComplaint(user.student_id, text);
    document.getElementById('complaintMsg').value = '';
    setTimeout(loadMyGrievanceReplies, 500);
}

async function loadMyGrievanceReplies() {
    const res = await fetch('/api/complaints');
    const all = await res.json();
    const my = all.filter(c => c.student_id === user.student_id);
    const box = document.getElementById('studentReplyBox');
    if (my.length === 0) {
        box.innerHTML = '';
        return;
    }
    box.innerHTML = my.map(c => `
      <div style="background: rgba(0,0,0,0.35); padding: 8px 10px; border-radius: 6px; margin-top: 6px; font-size: 11.5px;">
        <strong>You:</strong> ${c.message}<br>
        ${c.admin_reply ? `<strong style="color:#4cd964;">Admin:</strong> ${c.admin_reply}` : `<em style="color:#ffca28;">Waiting for Admin reply...</em>`}
      </div>
    `).join('');
}

function filterCatalog() {
    const q = document.getElementById('catalogSearch').value.toLowerCase();
    document.querySelectorAll('#catalogTbody tr').forEach(r => {
        r.style.display = r.innerText.toLowerCase().includes(q) ? '' : 'none';
    });
}

async function applyCSort() {
    const res = await fetch('/api/dsa/sort');
    renderCatalog(await res.json());
    alert('Catalog sorted alphabetically using compiled C QuickSort O(n log n)!');
}

async function executeBinarySearch() {
    const id = prompt('C Binary Search O(log n) ke liye Book ID enter karein (e.g. BK-101):');
    if (!id) return;
    const res = await fetch(`/api/dsa/search?id=${encodeURIComponent(id)}`);
    const d = await res.json();
    alert(d.found ? `Found via ${d.algorithm} at array index ${d.index}!` : `Not found!`);
}

loadStudentData();