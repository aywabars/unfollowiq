const https = require('https');
const crypto = require('crypto');

const IG_APP_ID = '936619743392459';
const BASE = 'www.instagram.com';

// ===== RAW HTTPS REQUEST (for login flow, no session needed) =====
function rawRequest(path, method = 'GET', headers = {}, body = null, cookies = '') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE,
      path,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.instagram.com/',
        'Origin': 'https://www.instagram.com',
        'X-IG-App-ID': IG_APP_ID,
        'X-Requested-With': 'XMLHttpRequest',
        ...(cookies ? { 'Cookie': cookies } : {}),
        ...headers
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
        // Parse Set-Cookie headers
        const setCookies = res.headers['set-cookie'] || [];
        const cookieMap = {};
        setCookies.forEach(c => {
          const match = c.match(/^([^=]+)=([^;]*)/);
          if (match) cookieMap[match[1]] = match[2];
        });
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), cookies: cookieMap, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data }, cookies: cookieMap, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body !== null) req.write(body);
    req.end();
  });
}

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
  },

  // ===== LOGIN WITH USERNAME/PASSWORD =====
  async loginWithCredentials(username, password) {
    // Step 1: Visit Instagram to get initial CSRF token
    const initRes = await rawRequest('/accounts/login/', 'GET');
    let csrfToken = initRes.cookies.csrftoken;

    if (!csrfToken) {
      // Try to extract from page content or shared data
      const match = (initRes.data.raw || '').match(/"csrf_token":"([^"]+)"/);
      if (match) csrfToken = match[1];
    }

    if (!csrfToken) {
      // Generate a random one as fallback (Instagram sometimes accepts this)
      csrfToken = crypto.randomBytes(16).toString('hex');
    }

    // Step 2: POST login with credentials
    const timestamp = Math.floor(Date.now() / 1000);
    const loginBody = `username=${encodeURIComponent(username)}&enc_password=${encodeURIComponent('#PWD_INSTAGRAM_BROWSER:0:' + timestamp + ':' + password)}&queryParams=%7B%7D&optIntoOneTap=false`;

    const loginRes = await rawRequest(
      '/accounts/login/ajax/',
      'POST',
      {
        'X-CSRFToken': csrfToken,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      loginBody,
      `csrftoken=${csrfToken}; mid=${crypto.randomBytes(14).toString('base64')}`
    );

    const loginData = loginRes.data;

    // Check for two-factor auth
    if (loginData.two_factor_required) {
      return {
        success: false,
        twoFactorRequired: true,
        twoFactorInfo: {
          identifier: loginData.two_factor_info?.two_factor_identifier,
          username: username,
          csrfToken: loginRes.cookies.csrftoken || csrfToken,
          methods: loginData.two_factor_info?.totp_two_factor_on ? ['totp'] : ['sms']
        },
        message: 'Two-factor authentication required. Please enter your security code.'
      };
    }

    // Check for checkpoint/challenge (suspicious login)
    if (loginData.checkpoint_url || loginData.message === 'checkpoint_required') {
      const checkpointUrl = loginData.checkpoint_url || '/challenge/';
      const allCookies = Object.entries(loginRes.cookies).map(([k,v]) => `${k}=${v}`).join('; ');

      try {
        // Step 1: GET the challenge page to see what's needed
        const challengeRes = await rawRequest(checkpointUrl, 'GET', {
          'X-CSRFToken': loginRes.cookies.csrftoken || csrfToken,
        }, null, allCookies);

        // Step 2: Request the verification code (choice=1 = email, choice=0 = SMS)
        const challengeCsrf = challengeRes.cookies.csrftoken || loginRes.cookies.csrftoken || csrfToken;
        const challengeCookies = Object.entries({...loginRes.cookies, ...challengeRes.cookies}).map(([k,v]) => `${k}=${v}`).join('; ');

        const sendCodeRes = await rawRequest(checkpointUrl, 'POST', {
          'X-CSRFToken': challengeCsrf,
          'Content-Type': 'application/x-www-form-urlencoded',
        }, 'choice=1', challengeCookies);

        const mergedCookies = {...loginRes.cookies, ...challengeRes.cookies, ...sendCodeRes.cookies};
        const finalCsrf = sendCodeRes.cookies.csrftoken || challengeCsrf;

        return {
          success: false,
          challengeRequired: true,
          challengeInfo: {
            checkpointUrl,
            csrfToken: finalCsrf,
            cookies: Object.entries(mergedCookies).map(([k,v]) => `${k}=${v}`).join('; '),
            username
          },
          message: 'Instagram sent a verification code to your email/phone. Please enter it below.'
        };
      } catch (challengeErr) {
        return {
          success: false,
          challengeRequired: true,
          message: 'Instagram requires verification. Please log in on instagram.com first to verify your identity, then try again.'
        };
      }
    }

    // Check if login was successful
    if (loginData.authenticated === true && loginData.status === 'ok') {
      const sessionId = loginRes.cookies.sessionid;
      const newCsrf = loginRes.cookies.csrftoken || csrfToken;
      const igUserId = loginData.userId;

      if (!sessionId) {
        return { success: false, message: 'Login seemed successful but no session cookie was returned. Please try again.' };
      }

      return {
        success: true,
        sessionId,
        csrfToken: newCsrf,
        igUserId: String(igUserId),
        username
      };
    }

    // Login failed
    return {
      success: false,
      message: loginData.message || 'Invalid username or password. Please check your credentials and try again.'
    };
  },

  // ===== VERIFY CHALLENGE CODE (checkpoint) =====
  async verifyChallenge(checkpointUrl, code, csrfToken, cookies, username) {
    const body = `security_code=${encodeURIComponent(code)}`;

    const res = await rawRequest(
      checkpointUrl,
      'POST',
      {
        'X-CSRFToken': csrfToken,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      cookies
    );

    // If challenge passes, Instagram redirects or returns a session
    const sessionId = res.cookies.sessionid;
    const newCsrf = res.cookies.csrftoken || csrfToken;

    if (sessionId) {
      return {
        success: true,
        sessionId,
        csrfToken: newCsrf,
        igUserId: res.data.userId ? String(res.data.userId) : null,
        username
      };
    }

    // Check if the response indicates success but via redirect
    if (res.status === 200 && res.data.status === 'ok') {
      // Try to extract session from merged cookies
      const allCookies = {...(function(){const m={};(cookies||'').split('; ').forEach(c=>{const p=c.split('=');if(p.length>=2)m[p[0]]=p.slice(1).join('=')});return m})(), ...res.cookies};
      if (allCookies.sessionid) {
        return {
          success: true,
          sessionId: allCookies.sessionid,
          csrfToken: newCsrf,
          igUserId: res.data.userId ? String(res.data.userId) : null,
          username
        };
      }
    }

    // Check for navigation/redirect that indicates we need to login again with cleared challenge
    if (res.data.location || res.headers?.location) {
      return {
        success: false,
        message: 'Verification accepted! Please try logging in again â it should work now.'
      };
    }

    return {
      success: false,
      message: res.data.message || 'Invalid verification code. Please check and try again.'
    };
  },

  // ===== LOGIN WITH SESSION COOKIE =====
  async loginWithCookie(sessionId) {
    // Try to get csrftoken and verify session in one call
    const res = await rawRequest('/api/v1/accounts/current_user/', 'GET', {}, null, `sessionid=${sessionId}`);

    if (res.status === 200 && res.data.user) {
      const csrfToken = res.cookies.csrftoken || crypto.randomBytes(16).toString('hex');
      return {
        success: true,
        sessionId,
        csrfToken,
        igUserId: String(res.data.user.pk),
        username: res.data.user.username
      };
    }

    return { success: false, message: 'Invalid or expired session cookie. Make sure you copied the full sessionid value from Instagram.' };
  },

  // ===== VERIFY 2FA CODE =====
  async verify2FA(identifier, code, username, csrfToken) {
    const body = `username=${encodeURIComponent(username)}&verificationCode=${encodeURIComponent(code)}&identifier=${encodeURIComponent(identifier)}&queryParams=%7B%7D`;

    const res = await rawRequest(
      '/accounts/login/ajax/two_factor/',
      'POST',
      {
        'X-CSRFToken': csrfToken,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      `csrftoken=${csrfToken}`
    );

    if (res.data.authenticated === true) {
      return {
        success: true,
        sessionId: res.cookies.sessionid,
        csrfToken: res.cookies.csrftoken || csrfToken,
        igUserId: String(res.data.userId),
        username
      };
    }

    return {
      success: false,
      message: res.data.message || 'Invalid security code. Please try again.'
    };
  }
};
