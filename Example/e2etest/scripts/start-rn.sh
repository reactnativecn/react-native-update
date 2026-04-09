#!/usr/bin/env bash

trap 'kill $RN_PID' EXIT

PLATFORM=$1

kill -9 $(lsof -i :8081 | awk '{print $2}' | tail -n +2) & npm start &
RN_PID=$!
sleep 2 && curl>/dev/null http://localhost:8081/index.bundle
wait $RN_PID
