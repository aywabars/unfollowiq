const https = require('https');

const IG_APP_ID = '936619743392459';
const BASE = 'www.instagram.com';

function makeRequest(path, session, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE,
      path,
      method,
      headers: {
        'Cookie': `sessionid=${session.session_id}; csrftoken=${session.csrf_token}`,
        'X-CSRFToken': session.csrf_token,
        'X-IG-App-ID': IG_APP_ID,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.instagram.com/',
        'Origin': 'https://www.instagram.com',
      }
    };

    if (body !== null) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body !== null) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  // Verify session is valid
  async verifySession(session) {
    const res = await makeRequest('/api/v1/accounts/current_user/', session);
    if (res.status === 200 && res.data.user) {
      return { valid: true, userId: res.data.user.pk, username: res.data.user.username };
    }
    return { valid: false };
  },

  // Fetch full list (following or followers)
  async fetchList(endpoint, igUserId, session, onProgress) {
    let allUsers = [];
    let maxId = null;
    let page = 0;

    while (true) {
      let path = `/api/v1/friendships/${igUserId}/${endpoint}/?count=200`;
      if (maxId) path += `&max_id=${encodeURIComponent(maxId)}`;

      const res = await makeRequest(path, session);

      if (res.status === 429) {
        onProgress?.(`Rate limited. Waiting 60s...`, 'warn');
        await sleep(60000);
        continue;
      }

      if (res.status !== 200 || res.data.status !== 'ok') {
        onProgress?.(`Error: HTTP ${res.status}`, 'error');
        break;
      }

      const users = res.data.users.map(u => ({
        username: u.username,
        pk: String(u.pk),
        full_name: u.full_name || ''
      }));

      allUsers = allUsers.concat(users);
      page++;
      onProgress?.(`${endpoint}: ${allUsers.length} collected (page ${page})`, 'info');

      if (!res.data.next_max_id) break;
      maxId = res.data.next_max_id;
      await sleep(2000); // 2s between scan pages to avoid detection
    }

    return allUsers;
  },

  // Unfollow a user
  async unfollowUser(pk, session) {
    const res = await makeRequest(`/api/v1/friendships/destroy/${pk}/`, session, 'POST', '');
    return { status: res.status, ok: res.status === 200 && res.data.status === 'ok', data: res.data };
  }
};
