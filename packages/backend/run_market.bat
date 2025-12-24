@echo off
title BinanceWeb3 - Local Market Server (Release)
echo [MARKET] Starting Local Market Server in Release mode...
cargo run --release --bin backend-market
pause
