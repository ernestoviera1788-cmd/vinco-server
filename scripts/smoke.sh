#!/bin/bash
# VINCÓ backend smoke test. Requires: Postgres running, migrations applied,
# server on :8080 (DATABASE_URL + NODE_ENV=development for devCode OTPs).
set -u
B=${BASE_URL:-http://localhost:8080/actions}
rpc() { curl -s -X POST "$B" -H 'Content-Type: application/json' -d "{\"action\":\"$1\",\"args\":$2,\"actionCallId\":\"smoke-$RANDOM\"}"; }
pass=0; fail=0
check() { # $1=desc $2=json $3=jq-expr $4=expected
  local got; got=$(echo "$2" | jq -r "$3" 2>/dev/null)
  if [ "$got" = "$4" ]; then pass=$((pass+1)); echo "ok   $1";
  else fail=$((fail+1)); echo "FAIL $1 (got '$got', want '$4')"; fi
}

R1=$(rpc register '{"email":"smoke1@test.com","password":"supersecret12","firstName":"Smoke","birthDate":"1995-06-15","gender":"woman","city":"Miami","country":"USA","locale":"en","acceptedTerms":true}')
T1=$(echo "$R1" | jq -r .data.token)
check "register returns token" "$R1" '.data.user.firstName' 'Smoke'
check "duplicate email" "$(rpc register '{"email":"smoke1@test.com","password":"supersecret12","firstName":"X","birthDate":"1990-01-01","gender":"man","city":"X","country":"USA","locale":"en","acceptedTerms":true}')" '.data.error' 'EMAIL_TAKEN'
check "underage rejected" "$(rpc register '{"email":"k@test.com","password":"supersecret12","firstName":"K","birthDate":"2015-01-01","gender":"man","city":"X","country":"USA","locale":"en","acceptedTerms":true}')" '.data.error' 'UNDERAGE'
check "bad birthdate" "$(rpc register '{"email":"d@test.com","password":"supersecret12","firstName":"D","birthDate":"2000-13-99","gender":"man","city":"X","country":"USA","locale":"en","acceptedTerms":true}')" '.data.error' 'INVALID_BIRTHDATE'
check "wrong password" "$(rpc login '{"identifier":"smoke1@test.com","password":"wrongpassword1"}')" '.data.error' 'INVALID_CREDENTIALS'
check "bad token" "$(rpc getme '{"token":"bogus-token-12345"}')" '.data.error' 'INVALID_TOKEN'
check "getme" "$(rpc getme "{\"token\":\"$T1\"}")" '.data.email' 'smoke1@test.com'

CODE=$(rpc requestverification "{\"token\":\"$T1\",\"channel\":\"email\"}" | jq -r .data.devCode)
check "otp verify" "$(rpc verifyotp "{\"token\":\"$T1\",\"channel\":\"email\",\"code\":\"$CODE\"}")" '.data.ok' 'true'

R2=$(rpc register '{"email":"smoke2@test.com","password":"supersecret12","firstName":"Smoke2","birthDate":"1992-03-20","gender":"man","city":"Miami","country":"USA","locale":"en","acceptedTerms":true}')
T2=$(echo "$R2" | jq -r .data.token); ID2=$(echo "$R2" | jq -r .data.user.id)
rpc updateprofile "{\"token\":\"$T1\",\"firstName\":\"Smoke\",\"bio\":\"hi\",\"city\":\"Miami\",\"state\":\"FL\",\"country\":\"USA\",\"gender\":\"woman\",\"intention\":\"dating\",\"occupation\":\"dev\",\"education\":\"uni\",\"hobbies\":\"run\",\"lifestyle\":\"active\",\"preferredGender\":\"man\",\"ageMin\":25,\"ageMax\":40,\"distanceMax\":100}" > /dev/null
rpc updateprofile "{\"token\":\"$T2\",\"firstName\":\"Smoke2\",\"bio\":\"hey\",\"city\":\"Miami\",\"state\":\"FL\",\"country\":\"USA\",\"gender\":\"man\",\"intention\":\"dating\",\"occupation\":\"dev\",\"education\":\"uni\",\"hobbies\":\"gym\",\"lifestyle\":\"active\",\"preferredGender\":\"woman\",\"ageMin\":25,\"ageMax\":40,\"distanceMax\":100}" > /dev/null
check "discovery finds user" "$(rpc listdiscovery "{\"token\":\"$T1\"}")" '.data.total' '1'

M1=$(rpc reacttoprofile "{\"token\":\"$T1\",\"targetId\":\"$ID2\",\"kind\":\"LIKE\"}" | jq -r .data.matched)
M2=$(rpc reacttoprofile "{\"token\":\"$T2\",\"targetId\":$(echo "$R1" | jq -r .data.user.id | jq -R .),\"kind\":\"LIKE\"}")
check "first like no match" "$M1" '.' 'false'
CONV=$(echo "$M2" | jq -r .data.conversationId)
check "mutual like matches" "$M2" '.data.matched' 'true'
check "sendmessage" "$(rpc sendmessage "{\"token\":\"$T1\",\"conversationId\":\"$CONV\",\"body\":\"hello\"}")" '.data.mine' 'true'
check "listmessages" "$(rpc listmessages "{\"token\":\"$T2\",\"conversationId\":\"$CONV\"}")" '.data.messages[0].body' 'hello'
check "likes gated" "$(rpc listlikes "{\"token\":\"$T2\"}")" '.data.error' 'LIKES_GATED'
check "checkout w/o stripe" "$(rpc createcheckout "{\"token\":\"$T1\",\"kind\":\"SUBSCRIPTION\",\"itemId\":\"premium-monthly\"}")" '.data.error' 'STRIPE_NOT_CONFIGURED'
check "admin gated" "$(rpc getadminoverview "{\"token\":\"$T2\"}")" '.data.error' 'ADMIN_ONLY'

echo "---"; echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
