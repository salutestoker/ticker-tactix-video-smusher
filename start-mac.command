#!/bin/zsh

cd "$(dirname "$0")" || exit 1

echo "Starting Ticker Tactix Video Smusher..."

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js is not installed. Install Node.js from https://nodejs.org/ and run this file again."
  echo ""
  read -k 1 "REPLY?Press any key to close."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo ""
  echo "Installing app dependencies. This only needs to happen the first time."
  npm install
  if [ $? -ne 0 ]; then
    echo ""
    echo "Dependency installation failed."
    read -k 1 "REPLY?Press any key to close."
    exit 1
  fi
fi

echo ""
echo "The browser should open automatically. Keep this window open while using the app."
npm start

echo ""
read -k 1 "REPLY?Press any key to close."
