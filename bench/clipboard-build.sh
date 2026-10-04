#!/bin/sh
set -eu
bank="$1"
case "$bank" in /private/tmp/sleight-clipboard-*) ;; *) exit 64 ;; esac
mkdir -p "$bank/cache"
/usr/bin/xcrun swiftc -module-cache-path "$bank/cache" -o "$bank/clipboard-fixture" bench/clipboard-fixture.swift
