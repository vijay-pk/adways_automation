#!/usr/bin/env bash
# Post-deploy checks: HTTPS certificate, health (DB), dashboard and API routes, and that the
# WordPress site on the main domain is unchanged. Usage: ./deploy/verify.sh [domain]
set -u  # no pipefail: grep -q closes pipes early by design
DOMAIN="${1:-automation.adwaysacademy.com}"
MAIN="https://adwaysacademy.com/"
fail=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }

echo "== ${DOMAIN}"
check "HTTPS certificate valid"            "curl -sS -o /dev/null https://${DOMAIN}/api/health"
check "HTTP redirects to HTTPS"            "[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://${DOMAIN}/)\" = 308 ]"
check "health: app + database ok"          "curl -fsS https://${DOMAIN}/api/health | grep -q '\"db\":\"ok\"'"
check "dashboard served"                    "curl -fsS https://${DOMAIN}/ | grep -q '<div id=\"root\">'"
check "dashboard deep link served"         "curl -fsS https://${DOMAIN}/approvals | grep -q '<div id=\"root\">'"
check "student chat route served"          "curl -fsS https://${DOMAIN}/chat | grep -q '<div id=\"root\">'"
check "admin API requires login (401)"     "[ \"\$(curl -s -o /dev/null -w '%{http_code}' https://${DOMAIN}/api/dashboard)\" = 401 ]"
check "no public registration (404)"       "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST https://${DOMAIN}/api/auth/register)\" = 404 ]"
check "HSTS header present"                "curl -sSI https://${DOMAIN}/ | grep -qi strict-transport-security"

echo "== WordPress (${MAIN}) must be unaffected"
check "main site responds 200"             "[ \"\$(curl -s -o /dev/null -w '%{http_code}' ${MAIN})\" = 200 ]"
check "main site still WordPress"          "curl -fsS ${MAIN} | grep -q 'wp-json'"
check "main site title unchanged"          "curl -fsS ${MAIN} | grep -q '<title>Adways Academy</title>'"

exit $fail
