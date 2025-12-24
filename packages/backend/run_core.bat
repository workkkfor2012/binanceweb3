@echo off
title BinanceWeb3 - Cloud Core Server (Release)
echo [CORE] Starting Cloud Core Server in Release mode...
cargo run --release --bin backend-core
pause
