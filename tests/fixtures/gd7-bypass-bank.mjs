const macHome = '/' + ['Users', 'u'].join('/');
// New bypass attempts onto protected paths. Strings only; the review never executes them.
// %P = protected file, %D = protected directory. Each template is expanded with 3 spellings.
const spell = [
  s => s.replaceAll('%P', '~/Library/Application\\ Support/sleight/hand.json').replaceAll('%D', '~/Library/Application\\ Support/sleight'),
  s => s.replaceAll('%P', '"$HOME/Library/Application Support/sleight/hand.json"').replaceAll('%D', '"$HOME/Library/Application Support/sleight"'),
  s => s.replaceAll('%P', (macHome + '/Library/Application\\ Support/sleight/hand.json')).replaceAll('%D', (macHome + '/Library/Application\\ Support/sleight')),
];
const W = ['touch %P', 'tee %P', 'echo x > %P', 'cp /tmp/x %P', 'rm -f %P'];
const cats = {};
const add = (cat, ...ts) => (cats[cat] ??= []).push(...ts.flat());
const wrap = (cat, f) => add(cat, W.map(w => f(w)));

// K1 keywords and groups
wrap('K1 case/select/until/while/coproc', w => `case x in x) ${w};; esac`);
wrap('K1 case/select/until/while/coproc', w => `case $y in (a|*) ${w} ;; esac`);
wrap('K1 case/select/until/while/coproc', w => `select i in a; do ${w}; break; done`);
wrap('K1 case/select/until/while/coproc', w => `until false; do ${w}; break; done`);
wrap('K1 case/select/until/while/coproc', w => `while :; do ${w}; break; done`);
wrap('K1 case/select/until/while/coproc', w => `coproc ${w}`);
wrap('K1 case/select/until/while/coproc', w => `coproc X { ${w}; }`);
wrap('K1 case/select/until/while/coproc', w => `for ((i=0;i<1;i++)); do ${w}; done`);
wrap('K1 case/select/until/while/coproc', w => `for i; do ${w}; done`);
wrap('K1 case/select/until/while/coproc', w => `if ${w}; then :; fi`);
wrap('K1 case/select/until/while/coproc', w => `while ${w}; do break; done`);
wrap('K1 case/select/until/while/coproc', w => `until ${w}; do :; done`);
wrap('K1 case/select/until/while/coproc', w => `if ! ${w}; then :; fi`);
wrap('K1 case/select/until/while/coproc', w => `[[ 1 ]] && ${w}`);
wrap('K1 case/select/until/while/coproc', w => `(( 1 )) && ${w}`);
wrap('K1 case/select/until/while/coproc', w => `[ 1 ] && { ${w}; }`);
wrap('K1 case/select/until/while/coproc', w => `true && ! ${w}`);
wrap('K1 case/select/until/while/coproc', w => `{ ${w} & } ; wait`);
wrap('K1 case/select/until/while/coproc', w => `( ${w} ) &`);
wrap('K1 case/select/until/while/coproc', w => `${w} |& cat`);
wrap('K1 case/select/until/while/coproc', w => `echo | ${w}`);
wrap('K1 case/select/until/while/coproc', w => `if true; then if true; then { ${w}; }; fi; fi`);
wrap('K1 case/select/until/while/coproc', w => `{ { { ${w}; }; }; }`);
wrap('K1 case/select/until/while/coproc', w => `time ${w}`);
wrap('K1 case/select/until/while/coproc', w => `time -p ${w}`);
wrap('K1 case/select/until/while/coproc', w => `time { ${w}; }`);
wrap('K1 case/select/until/while/coproc', w => `elif=1; if false; then :; elif true; then ${w}; fi`);
wrap('K1 case/select/until/while/coproc', w => `function f { ${w}; }; f`);
wrap('K1 case/select/until/while/coproc', w => `function f() { ${w}; }; f`);
wrap('K1 case/select/until/while/coproc', w => `f() ( ${w} ); f`);
wrap('K1 case/select/until/while/coproc', w => `f() if true; then ${w}; fi; f`);
wrap('K1 case/select/until/while/coproc', w => `f() { ${w}; }
f`);
wrap('K1 case/select/until/while/coproc', w => `f() { g; }; g() { ${w}; }; f`);

// K2 command-position prefixes
for (const pre of ['command', 'command -p', 'builtin', 'exec', 'exec -a x', '\\', 'env', 'env -i', 'env -u X', 'nohup', 'nice', 'nice -n 5', 'timeout 5', 'stdbuf -oL', 'setsid', 'caffeinate', 'caffeinate -i', 'sudo', 'sudo -n', 'sudo -u u', 'doas', 'unbuffer', 'time', 'noglob', 'nocorrect', 'ionice', 'lockf -k x', 'flock x', 'arch -arm64', 'arch -x86_64', 'taskpolicy -b', 'taskpolicy -c background', 'script -q /dev/null', 'script -q /tmp/x', 'chroot /', 'xargs', 'xargs -n1', 'xargs -I{}', 'sandbox-exec -p x', 'dtruss', 'strace', 'watch -n1', 'rlwrap', 'su root -c', 'sg staff -c', 'launchctl submit -l x --', 'open -a', 'chrt', 'cpulimit -l 5 --', 'parallel', 'gtime', 'gtimeout 5', 'gnice', 'gstdbuf -oL', 'genv', 'reattach-to-user-namespace', 'caffeinate -d', 'dscl . -read', 'disown;', 'nohup nice', 'env A=1 nice', 'A=1 B=2', 'A=$(echo 1)', 'FOO=bar command'])
  add('K2 prefixes', W.map(w => `${pre} ${w}`));
add('K2 prefixes', W.map(w => `'${w.split(' ')[0]}' ${w.split(' ').slice(1).join(' ')}`), W.map(w => `"${w.split(' ')[0]}" ${w.split(' ').slice(1).join(' ')}`), W.map(w => `/usr/bin/${w}`), W.map(w => `/bin/${w}`));
add('K2 prefixes', W.map(w => `to""uch x; ${w.replace('touch', 'to\\uch')}`));

// K3 eval, sourcing, trap, shells reading text
const bodies = ['touch %P', 'echo x > %P', 'tee %P < /dev/null'];
for (const b of bodies) {
  add('K3 eval/source/stdin', `eval '${b}'`, `eval "${b}"`, `eval ${b}`, `eval -- ${b}`, `eval "eval ${b}"`, `command eval '${b}'`, `builtin eval '${b}'`,
    `eval $'${b}'`, `eval "$(echo '${b}')"`, `eval "$(printf %s '${b}')"`, `eval "\`echo '${b}'\`"`, `x='${b}'; eval "$x"`, `eval "$x"`,
    `source <(echo '${b}')`, `. <(echo '${b}')`, `source /dev/stdin <<< '${b}'`, `. /dev/stdin <<< '${b}'`, `source /dev/fd/0 <<EOF\n${b}\nEOF`,
    `source <(printf '%s' '${b}')`, `. <(cat <<< '${b}')`, `builtin source <(echo '${b}')`, `command . <(echo '${b}')`, `{ . <(echo '${b}'); }`, `true && source <(echo '${b}')`,
    `bash <<< '${b}'`, `bash <<'EOF'\n${b}\nEOF`, `sh -s <<< '${b}'`, `bash -s -- <<< '${b}'`, `zsh <<< '${b}'`, `exec bash <<< '${b}'`, `bash <(echo '${b}')`, `sh <(echo '${b}')`,
    `bash /dev/stdin <<< '${b}'`, `echo '${b}' | sh`, `echo '${b}' | bash`, `echo '${b}' | zsh`, `printf '%s' '${b}' | sh -s`, `echo '${b}' | xargs -I{} sh -c '{}'`, `echo '${b}' | xargs sh -c`,
    `cat <<'EOF' | sh\n${b}\nEOF`, `cat <<EOF | bash\n${b}\nEOF`, `trap '${b}' EXIT`, `trap "${b}" ERR`, `trap '${b}' 0`, `trap '${b}' EXIT; true`, `PROMPT_COMMAND='${b}'`,
    `bash -c '${b}'`, `sh -ec '${b}'`, `sh -c -- '${b}'`, `sh -o errexit -c '${b}'`, `bash --noprofile -c '${b}'`, `bash -O extglob -c '${b}'`, `sh -c '${b}' sh arg`, `bash -c '${b}' _`, `env -i bash -c '${b}'`,
    `bash -x -c '${b}'`, `zsh -fc '${b}'`, `ksh -c '${b}'`, `dash -c '${b}'`, `fish -c '${b}'`, `csh -c '${b}'`, `tcsh -c '${b}'`, `busybox sh -c '${b}'`, `/bin/bash -c '${b}'`, `bash --login -c '${b}'`,
    `sudo sh -c '${b}'`, `su root -c '${b}'`, `echo $(${b})`, `echo \`${b}\``, `cat <(${b})`, `echo >(${b})`, `: $(${b})`, `x=$(${b})`,
    `find . -maxdepth 0 -exec sh -c '${b}' \\;`, `awk 'BEGIN{system("${b}")}'`, `python3 -c 'import os; os.system("${b}")'`, `perl -e 'system("${b}")'`, `node -e 'require("child_process").execSync("${b}")'`,
    `ruby -e 'system("${b}")'`, `osascript -e 'do shell script "${b}"'`, `php -r 'system("${b}");'`, `lua -e 'os.execute("${b}")'`);
}

// D directory tracking, cwd really inside the protected folder
const inD = ['touch hand.json', 'echo x > hand.json', 'tee hand.json', 'cp /tmp/x hand.json', 'rm -f hand.json'];
const dirForms = [
  d => `cd ${d}; cd /tmp; cd "\${OLDPWD:?}"; %`, d => `cd ${d}; cd /tmp; cd \${OLDPWD-.}; %`, d => `cd ${d}; cd /tmp; pushd - >/dev/null; %`, d => `cd ${d}; cd /tmp; cd -- "$OLDPWD"; %`,
  d => `cd ${d}; cd /tmp && cd - >/dev/null; %`, d => `cd ${d}; cd -P .; %`, d => `cd ${d}; cd -L ./; %`, d => `cd ${d}; cd .; %`, d => `cd ${d}; true & %`,
  d => `cd ${d}; ( cd /tmp ); %`, d => `cd ${d}; ( cd /tmp; true ); %`, d => `cd ${d}; $(cd /tmp); %`, d => `cd ${d}; echo $(cd /tmp); %`, d => `cd ${d}; x=$(cd /tmp); %`, d => 'cd ' + d + '; x=`cd /tmp`; %',
  d => `cd ${d}; cd /tmp |& cat; %`, d => `cd ${d}; cd /tmp > /dev/null & wait; %`, d => `cd ${d}; cd nonexistent-dir 2>/dev/null; %`, d => `cd ${d}; cd /tmp/does-not-exist || true; %`,
  d => `cd ${d}; { cd /tmp; } ; cd ${d}; %`, d => `cd ${d} && %`, d => `cd ${d}\n%`, d => `cd ${d}/. && %`, d => `cd ${d}// && %`, d => `cd ${d}/../sleight && %`, d => `builtin cd ${d} && %`, d => `command cd ${d} && %`,
  d => `\\cd ${d} && %`, d => `'cd' ${d} && %`, d => `cd -- ${d} && %`, d => `cd -P ${d} && %`, d => `cd -L ${d} && %`, d => `chdir ${d} && %`, d => `pushd ${d} >/dev/null && %`, d => `pushd ${d} && pushd /tmp && popd && %`,
  d => `cd ${d}; pushd /tmp; popd; %`, d => `cd ${d}; pushd /tmp; cd /var; popd; %`, d => `cd /tmp; cd ${d}; cd /tmp; popd 2>/dev/null; cd ${d}; %`,
  d => `cd ~/Library && cd Application\\ Support && cd sleight && %`, d => `cd ~/Library; cd "Application Support"; cd sleight; %`, d => `cd ~/Library/Application\\ Support/sleight/.. && cd sleight && %`,
  d => `cd ~/Library/"Application Support"/sleight && %`, d => `cd ~/Library/Application\\ Support/sleight/../sleight && %`, d => `cd ~/Library/Application\\ Support; cd ./sleight; %`,
  d => `cd ~/Library/Application\\ Support/sl*; %`, d => `cd ~/Library/App*/sleight; %`, d => `cd ~/L*/A*/s*; %`, d => `cd ~/Library/Application\\ Support/{sleight,x}; %`, d => `cd ~/Library/Application\\ Support/slei?ht; %`,
  d => `dir=${d}; cd $dir; %`, d => `read dd <<< ${d}; cd "$dd"; %`, d => `HOME=${d} cd; %`, d => `HOME=${d}; cd; %`, d => `export HOME=${d}; cd ~; %`,
  d => `cd ${d}; set -e; false || true; %`, d => `cd ${d}; (exit 1) || true; %`, d => `cd ${d}; if cd /tmp; then cd ${d}; fi; %`, d => `cd ${d}; for i in 1; do cd /tmp; done; cd ${d}; %`,
  d => `cd ${d}; cd /tmp/link-to-d; %`, d => `cd /tmp/link-to-d && %`, d => `cd ${d}; cd /tmp/link-to-d/..; cd sleight; %`, d => `cd /tmp/link-to-d/../sleight && %`,
  d => `cd ${d} 2>&1 && %`, d => `cd ${d} >/dev/null && %`, d => `cd ${d} &>/dev/null && %`, d => `cd ${d} || exit 1; %`, d => `[ -d ${d} ] && cd ${d}; %`, d => `cd ${d} && (cd /tmp) && %`,
  d => `cd ${d} && f() { cd /tmp; }; %`, d => `cd ${d} && alias cd=:; %`, d => `cd ${d} && eval 'cd /tmp'; %`, d => `cd ${d} && source /dev/null; %`, d => `cd ${d} && . /dev/null; %`, d => `cd ${d} && trap 'cd /tmp' EXIT; %`,
  d => `cd ${d} && bash -c 'cd /tmp'; %`, d => `cd ${d} && sh -c 'cd /tmp' && %`, d => `cd ${d} && env cd /tmp; %`, d => `cd ${d} && command -p cd /tmp; %`, d => `cd ${d} && exec true; %`,
];
const dirs = ['~/Library/Application\\ Support/sleight', '"$HOME/Library/Application Support/sleight"', (macHome + '/Library/Application\\ Support/sleight')];
for (const f of dirForms) for (const d of dirs.slice(0, 2)) for (const w of inD) add('D directory tracking', f(d).replace('%', w));

// W writers
const dest = [s => s.replaceAll('%P', '~/Library/Application\\ Support/sleight/hand.json'), s => s.replaceAll('%P', '"$HOME/Library/Application Support/sleight/hand.json"'), s => s.replaceAll('%P', (macHome + '/Library/Application\\ Support/sleight/hand.json'))];
const writerTemplates = {
  'W wget': ['wget -qO %P u', 'wget -nvqO %P u', 'wget -q -O %P u', 'wget --output-document=%P u', 'wget -o %P u', 'wget -a %P u', 'wget --append-output=%P u', 'wget -P %P u', 'wget --directory-prefix=%P u', 'wget --save-cookies %P u',
    'wget --rejected-log %P u', 'wget --warc-file %P u', 'wget --hsts-file %P u', 'wget -e logfile=%P u', 'wget -e dir_prefix=%P u', 'wget -ncqO %P u', 'wget -qO%P u', 'wget --output-file %P u', 'wget -S -qO %P u', 'wget -e robots=off -qO %P u', 'wget -t 3 -qO %P u', 'wget -qO %P u -nv',
    'gwget -qO %P u', 'wget -qNP %P u', 'wget --no-check-certificate -qO %P u', 'wget -x u -P %P', 'wget --mirror -P %P u', 'wget -r -P %P u', 'wget -i list -P %P', 'wget -O- u > %P', 'wget -qO- u | tee %P'],
  'W curl': ['curl -fsSLo %P u', 'curl -o %P u', 'curl --output %P u', 'curl -D %P u', 'curl -c %P u', 'curl --cookie-jar %P u', 'curl --trace %P u', 'curl --trace-ascii %P u', 'curl --stderr %P u', 'curl --libcurl %P u', 'curl --dump-header %P u', 'curl --etag-save %P u', 'curl --hsts %P u',
    'curl --alt-svc %P u', 'curl -w "%output{%P}" u', 'curl -O --output-dir %P u', 'curl --create-dirs -o %P u', 'curl --remote-name-all --output-dir %P u', 'curl -K cfg -o %P u', 'curl --ssl-sessions %P u', 'curl --trace-time --trace %P u', 'curl -sSo %P u', 'curl -sS -o%P u', 'curl --output=%P u', 'curl -sSL u -o %P', 'curl u --output %P'],
  'W archive': ['unzip a.zip -d %P', 'unzip -d %P a.zip', 'unzip -o a.zip -d%P', 'unzip -oqd %P a.zip', 'unzip -qd %P a.zip', 'ditto -x a.zip %P', 'ditto a %P', '7z x a -o%P', '7za x a -o%P', 'bsdtar -xf a -C %P', 'tar --one-top-level=%P -xf a', 'tar xf a -C %P', 'tar --directory=%P -xf a', 'tar -C %P -xf a', 'tar -xf a --transform s,a,%P,', 'tar -cf %P src', 'tar cf %P src', 'tar czf %P src', 'tar --file=%P -c src', 'tar -xf a -C %P', 'gtar -xf a -C %P', 'gtar xf a -C %P', 'gtar --directory %P -xf a', 'gtar -cf %P src', 'zip %P x', 'zip -r %P x', 'cpio -idv -D %P < a', 'pax -w -f %P x', 'hdiutil create %P', 'tar -xzf a --directory=%P', 'tar -zxf a -C%P', 'tar xzvf a -C %P', 'tar -v -x -f a -C %P', 'bsdtar -cf %P x', 'xar -cf %P x', 'ar rc %P x'],
  'W gnu': ['gtouch %P', 'gtee %P', 'gcp /tmp/x %P', 'gmv /tmp/x %P', 'gdd of=%P', 'gln -s /tmp/x %P', 'grm -f %P', 'gchmod 000 %P', 'gchown u %P', 'gchgrp staff %P', 'gtruncate -s0 %P', 'gsort -o %P a', 'gsort -o%P a', 'gsplit a %P', 'gmkdir -p %P', 'gshred %P', 'gunlink %P', 'gsed -i s/a/b/ %P', 'gfind %P -delete', 'gfind . -name x -exec rm %P ;', 'ginstall -D /tmp/x %P', 'gpatch %P < x', 'gawk -i inplace 1 %P', 'awk -i inplace 1 %P', 'gtruncate --size=0 %P', 'gcp -t %P /tmp/x', 'grmdir %P', 'gtac a > %P', 'gcat a > %P', 'gtr a b > %P', 'gmktemp %P.XXXX', 'gln -sf x %P', 'glink x %P', 'gmv -t %P x', 'gtee -a %P', 'gdd if=/dev/zero of=%P count=1', 'gsed -n -i p %P', 'gsed --in-place p %P', 'gsed -i.bak p %P', 'gsed -s -i p %P', 'gxargs touch < %P', 'ggrep -rl x . | gxargs rm', 'gcsplit a 1 -f %P', 'gshuf -o %P a', 'guniq a %P', 'gsum > %P'],
  'W sed': ['sed $"-i" "" p %P', 'sed $"-i" p %P', "sed $'-i' p %P", 'sed "$(echo -i)" p %P', 'sed -$"i" "" p %P', 'sed $"--in-place" p %P', 'sed $"-I" p %P', 'sed $"-ni" p %P', 'sed -n $"-i" p %P', 'sed -E $"-i" "" p %P', 'sed $"-i".bak p %P', 'sed -e p $"-i" %P', 'sed --in-place=.bak p %P', 'sed -i\'\' p %P', 'sed -i"" p %P', 'sed -i "" -e p %P', 'sed -f script -i %P', 'sed -ibak p %P', 'sed -I p %P', 'sed -si p %P', 'sed -n w%P', 'sed -n "p;w %P"', 'sed -e "w %P"', 'sed "w %P"', 'sed s/a/b/w%P x', 'sed "s/a/b/w %P" x', "sed 's/a/b/ w %P' x", 'sed -n "/x/w %P" in', 'sed "1w %P" in', 'sed "\\$w %P" in', 'sed "r %P" in', 'sed -u -i p %P'],
  'W misc': ['taskpolicy -b tee %P', 'taskpolicy -c background -d throttle tee %P', 'taskpolicy -t 1 -l 2 tee %P', 'taskpolicy -B tee %P', 'taskpolicy -g default tee %P', 'taskpolicy -p 1', 'script -q /dev/null tee %P', 'script %P', 'script -a %P', 'script -q %P ls', 'script -q -t 0 %P ls', 'script -F %P ls', 'script -k %P ls', 'script -r %P ls', 'script -q /dev/null touch %P', 'script -c "touch %P" /dev/null',
    'chroot / tee %P', 'chroot --userspec=u / tee %P', 'chroot /tmp tee %P', 'install -d %P', 'install /tmp/x %P', 'mkdir %P', 'mkdir -p %P', 'mktemp %P.XXXX', 'xattr -w k v %P', 'xattr -c %P', 'SetFile -a V %P', 'rmdir %P', 'trash %P', 'rsync a %P', 'rsync -a a/ %P/', 'cp -c /tmp/x %P', 'cp -t %P /tmp/x', 'mv -t %P /tmp/x', 'ln -sf /tmp/x %P', 'link /tmp/x %P',
    'defaults write %P k v', 'plutil -insert k -string v %P', '/usr/libexec/PlistBuddy -c "Add :k string v" %P', 'PlistBuddy -c "Set :k v" %P', 'sponge %P', 'jq . x | sponge %P', 'tr a b < in > %P', 'csplit in 1 -f %P', 'shuf -o %P a', 'sort -o %P a', 'uniq a %P', 'base64 -o %P a', 'openssl enc -out %P', 'openssl req -x509 -out %P -keyout %P', 'ssh-keygen -f %P', 'gpg -o %P x', 'python3 -m json.tool in %P', 'screencapture %P', 'say -o %P hi', 'afconvert in %P', 'sips -o %P in', 'textutil -convert txt -output %P in', 'ffmpeg -i in %P', 'convert in %P',
    'git config --file %P k v', 'git config -f %P k v', 'git --git-dir=%P init', 'git init %P', 'git clone u %P', 'git worktree add %P', 'git archive -o %P HEAD', 'git format-patch -o %P HEAD~1', 'git diff --output=%P', 'git log --output=%P', 'git show --output=%P',
    'sqlite3 %P "create table t(a)"', 'sqlite3 %P .dump', 'awk \'BEGIN{print "x" > "%P"}\'', 'awk \'{print > "%P"}\' in', 'perl -e \'open(F,">%P");print F "x"\'', 'perl -pi -e s/a/b/ %P', 'ruby -pi -e "x" %P', 'ed -s %P <<< w', 'ex -sc "w" -c q %P', 'vi -es +w +q %P', 'python3 -c "open(\'%P\',\'w\')"', 'node -e "require(\'fs\').writeFileSync(\'%P\',\'x\')"', 'ruby -e "File.write(\'%P\',\'x\')"', 'osascript -e \'do shell script "touch %P"\'', 'osascript -e \'write "x" to POSIX file "%P"\'',
    ': > %P', '> %P', '>| %P', '>> %P', '&> %P', '&>> %P', '1> %P', '2> %P echo', 'exec 3> %P', 'exec {fd}> %P', ': <> %P', 'cat >&2 2> %P', 'echo x |& tee %P', 'echo >${HOME}/Library/Application\\ Support/sleight/hand.json', 'echo > ~/Library/Application\\ Support/sl*/hand.json', 'echo > ~/Library/Application\\ Support/{sleight,x}/hand.json', 'echo > ~/Library/Application\\ Support/sleight/./hand.json', 'echo > ~/Library/Application\\ Support//sleight/hand.json',
    'echo > ~u/Library/Application\\ Support/sleight/hand.json', 'echo > "~/Library/Application Support/sleight/hand.json"', 'echo > $HOME/Library/Application\\ Support/sleight/hand.json', 'echo > ${HOME}/Library/Application\\ Support/sleight/hand.json', 'P=%P; echo > "$P"', 'echo > "$(echo %P)"', 'echo > $(printf %s %P)', 'echo > "${P:-%P}"', 'echo > ~/Library/Application\\ Support/sleight/hand.j*', 'echo > ~/Library/Application\\ Support/sleight/hand.js[o]n'],
};
for (const [cat, ts] of Object.entries(writerTemplates)) for (const t of ts) for (const d of dest) add(cat, d(t));

export const banks = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, v.flatMap(c => /%[PD]/.test(c) ? spell.map(f => f(c)) : [c])]));
