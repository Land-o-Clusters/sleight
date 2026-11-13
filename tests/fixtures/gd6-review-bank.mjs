const macHome = '/' + ['Users', 'u'].join('/');
// GD5 review t7, t5, t9, t18 and t13 banks, preserved as data. Never execute their command strings.
import { protectedTargets } from './gd3-write-cases.mjs';
export const P = '~/Library/Application\\ Support/sleight/hand.json', AS = '~/Library/Application\\ Support';
export const keywordWriters = [p => `touch ${p}`, p => `tee ${p}`, p => `cp /tmp/x ${p}`, p => `mv /tmp/x ${p}`, p => `rm -f ${p}`, p => `sed -i '' s/a/b/ ${p}`, p => `echo x > ${p}`, p => `chmod 000 ${p}`, p => `dd of=${p}`, p => `truncate -s 0 ${p}`, p => `ln -sf /tmp/x ${p}`];
export const keywordWrappers = [c => c, c => `{ ${c}; }`, c => `{ ${c} ; }`, c => `{\n${c}\n}`, c => `if true; then ${c}; fi`, c => `if true; then\n${c}\nfi`, c => `if false; then :; else ${c}; fi`, c => `for i in 1; do ${c}; done`, c => `while true; do ${c}; break; done`, c => `until false; do ${c}; break; done`, c => `case x in x) ${c};; esac`, c => `! ${c}`, c => `time ${c}`, c => `time -p ${c}`, c => `f() { ${c}; }; f`, c => `function f { ${c}; }; f`, c => `(${c})`, c => `( ${c} )`, c => `true && { ${c}; }`, c => `true || ${c}`, c => `eval "${c}"`, c => `eval '${c}'`, c => `eval ${c}`, c => `builtin eval "${c}"`, c => `source <(echo '${c}')`, c => `bash <<< '${c}'`, c => `sh <<EOF\n${c}\nEOF`, c => `echo '${c}' | sh`, c => `echo '${c}' | bash -s`, c => `select i in a; do ${c}; break; done`, c => `[[ 1 ]] && ${c}`, c => `[ 1 ] && ${c}`, c => `((1)) && ${c}`, c => `trap '${c}' EXIT`, c => `exec ${c}`, c => `command ${c}`, c => `env ${c}`, c => `xargs ${c} <<< x`, c => `find /tmp -maxdepth 0 -exec ${c} \\;`, c => `while read l; do ${c}; done <<< x`, c => `: ; ${c}`, c => `\\${c}`];

export const keywordCases = keywordWrappers.flatMap(wrap => keywordWriters.map(write => wrap(write(P))));

export const spellings = {
  json: p => JSON.stringify(p),
  esc: p => p.replaceAll(' ', '\\ '),
  home: p => JSON.stringify(p.replace(/^~/, '$HOME')),
  abs: p => JSON.stringify(p.replace(/^~/, (macHome))),
  sq: p => "'" + p.replace(/^~/, (macHome)) + "'",
};
export const reviewerForms = {
  // sed in-place spellings
  "sed $'-i'": p => `sed $'-i' '' 's/a/b/' ${p}`, "sed $'-I'": p => `sed $'-I' '' 's/a/b/' ${p}`, "sed -$'I'": p => `sed -$'I' '' 's/a/b/' ${p}`, "sed $'-i.bak'": p => `sed $'-i.bak' 's/a/b/' ${p}`,
  'sed $"-i"': p => `sed $"-i" '' 's/a/b/' ${p}`, 'sed "-i"': p => `sed "-i" '' 's/a/b/' ${p}`, "sed '-I'": p => `sed '-I' '' 's/a/b/' ${p}`, "sed $'\\x2di'": p => `sed $'\\x2di' '' 's/a/b/' ${p}`, "sed $'\\055I'": p => `sed $'\\055I' '' s/a/b/ ${p}`,
  "sed $'-n' $'-i'": p => `sed $'-n' $'-i' '' s/a/b/ ${p}`, 'gsed -i': p => `gsed -i 's/a/b/' ${p}`, 'gsed -I?': p => `gsed -i.bak 's/a/b/' ${p}`, '/opt/homebrew/bin/gsed -i': p => `/opt/homebrew/bin/gsed -i s/a/b/ ${p}`,
  'sed --in-place': p => `sed --in-place s/a/b/ ${p}`, 'sed -s -i': p => `sed -s -i s/a/b/ ${p}`, 'sed -E -i': p => `sed -E -i '' s/a/b/ ${p}`, 'sed -I.bak': p => `sed -I.bak s/a/b/ ${p}`,
  // curl
  'curl -fsSLo': p => `curl -fsSLo ${p} http://x/y`, 'curl -sSLo': p => `curl -sSLo ${p} http://x/y`, 'curl -Lo': p => `curl -Lo ${p} http://x/y`, 'curl -so': p => `curl -so ${p} http://x/y`, 'curl -o': p => `curl -o ${p} http://x/y`,
  'curl -fsSLo attached': p => `curl -fsSLo${p} http://x/y`, 'curl --output': p => `curl --output ${p} http://x/y`, 'curl --output=': p => `curl --output=${p} http://x/y`, 'curl -fsSL -o': p => `curl -fsSL -o ${p} http://x/y`,
  'curl -D': p => `curl -D ${p} http://x/y`, 'curl -c': p => `curl -c ${p} http://x/y`, 'curl --cookie-jar': p => `curl --cookie-jar ${p} http://x/y`, 'curl --trace': p => `curl --trace ${p} http://x/y`, 'curl --trace-ascii': p => `curl --trace-ascii ${p} http://x/y`, 'curl --stderr': p => `curl --stderr ${p} http://x/y`, 'curl --libcurl': p => `curl --libcurl ${p} http://x/y`, 'curl --dump-header': p => `curl --dump-header ${p} http://x/y`, 'curl -fsSLD': p => `curl -fsSLD ${p} http://x/y`, 'curl --create-dirs -o': p => `curl --create-dirs -o ${p} http://x/y`, 'curl --remote-name --output-dir': p => `curl --remote-name --output-dir ${p} http://x/hand.json`,
  'curl -O --output-dir': p => `curl -O --output-dir ${p} http://x/hand.json`, 'curl -sS -O --output-dir': p => `curl -sS -O --output-dir ${p} http://x/hand.json`, 'curl -sSO --output-dir': p => `curl -sSO --output-dir ${p} http://x/hand.json`, 'curl --output-dir first': p => `curl --output-dir ${p} -O http://x/hand.json`, 'curl -OL --output-dir': p => `curl -OL --output-dir ${p} http://x/hand.json`, 'curl -fsSLO --output-dir=': p => `curl -fsSLO --output-dir=${p} http://x/hand.json`, 'curl url -O --output-dir': p => `curl http://x/hand.json -O --output-dir ${p}`, 'curl --output-dir --remote-name-all': p => `curl --remote-name-all --output-dir ${p} http://x/hand.json http://x/b`,
  // wget
  'wget -O': p => `wget -O ${p} http://x/y`, 'wget -qO': p => `wget -qO ${p} http://x/y`, 'wget -P': p => `wget -P ${p} http://x/y`, 'wget -a': p => `wget -a ${p} http://x/y`, 'wget -o': p => `wget -o ${p} http://x/y`, 'wget --append-output': p => `wget --append-output=${p} http://x/y`, 'wget --output-file': p => `wget --output-file ${p} http://x/y`, 'wget --save-cookies': p => `wget --save-cookies ${p} http://x/y`, 'wget --directory-prefix': p => `wget --directory-prefix=${p} http://x/y`,
  // archive
  'bsdtar -xf -C': p => `bsdtar -xf a.tar -C ${p}`, 'tar -xf --cd': p => `tar -xf a --cd ${p}`, 'tar -xf -C': p => `tar -xf a -C ${p}`, 'tar -xf --directory': p => `tar -xf a --directory ${p}`, 'tar -C attached': p => `tar -xf a -C${p}`, 'bsdtar --cd=': p => `bsdtar -xf a --cd=${p}`, 'bsdtar -xvf -C': p => `bsdtar -xvf a.tar.gz -C ${p}`, 'tar xzf -C': p => `tar xzf a.tgz -C ${p}`, 'tar -C first': p => `tar -C ${p} -xf a`, 'bsdtar -C first': p => `bsdtar -C ${p} -xf a`, 'unzip -d': p => `unzip a.zip -d ${p}`, 'unzip -d attached': p => `unzip a.zip -d${p}`, 'ditto -x': p => `ditto -x a.zip ${p}`, 'gtar -xf -C': p => `gtar -xf a -C ${p}`,
  // arch & wrappers
  'arch -arm64 tee': p => `arch -arm64 tee ${p}`, 'arch -x86_64 tee': p => `arch -x86_64 tee ${p}`, 'arch -arm64 sh -c touch': p => `arch -arm64 sh -c 'touch ${p}'`, 'arch -arm64 -e A=1 tee': p => `arch -arm64 env A=1 tee ${p}`, 'arch tee': p => `arch tee ${p}`, 'arch -arm64e cp': p => `arch -arm64e cp /tmp/x ${p}`, 'arch -arch arm64 tee': p => `arch -arch arm64 tee ${p}`, 'arch -64 tee': p => `arch -64 tee ${p}`, 'arch -c tee': p => `arch -c tee ${p}`, 'arch -arm64 nice tee': p => `arch -arm64 nice tee ${p}`, 'taskpolicy -b tee': p => `taskpolicy -b tee ${p}`, 'script -q /dev/null tee': p => `script -q /dev/null tee ${p}`, 'caffeinate -i tee': p => `caffeinate -i tee ${p}`, 'time tee': p => `time tee ${p}`, 'nohup tee': p => `nohup tee ${p}`, 'env -i tee': p => `env -i tee ${p}`, 'chroot': p => `chroot / tee ${p}`, 'zsh -c nested': p => `zsh -c 'bash -c "touch ${p}"'`,
  // GNU names
  'gcp': p => `gcp /tmp/x ${p}`, 'gcp -t': p => `gcp -t ${p} /tmp/x`, 'gmv': p => `gmv /tmp/x ${p}`, 'ginstall -Dt': p => `ginstall -Dt ${p} /tmp/x`, 'ginstall': p => `ginstall /tmp/x ${p}`, 'gtee': p => `gtee ${p}`, 'gdd of': p => `gdd of=${p}`, 'gtruncate': p => `gtruncate -s 0 ${p}`, 'gln': p => `gln -sf /tmp/x ${p}`, 'gtouch': p => `gtouch ${p}`, 'grm': p => `grm -f ${p}`, 'gchmod': p => `gchmod 000 ${p}`, 'gsort -o': p => `gsort -o ${p} /tmp/x`, 'gunlink': p => `gunlink ${p}`, 'gshred': p => `gshred -u ${p}`, 'gmkdir': p => `gmkdir -p ${p}`, 'gfind -delete': p => `gfind ${p} -delete`, 'gtar': p => `gtar -xf a -C ${p}`, 'gcat >': p => `gcat /tmp/x > ${p}`, 'gsplit': p => `gsplit -l 1 /tmp/x ${p}`, 'gtac >': p => `gtac /tmp/x > ${p}`,
  // sh -c quoting
  'sh -c dq touch': p => `sh -c "touch ${p.replaceAll('"', '')}"`,
};
// The sh -c double-quoted forms use backslash-space as Claude writes them
export const shellForms = {
  'sh -c "touch esc"': e => `sh -c "touch ${e}"`, 'bash -c "echo > esc"': e => `bash -c "echo x > ${e}"`, 'zsh -c "tee -a esc"': e => `zsh -c "tee -a ${e}"`, 'sh -c "cp esc"': e => `sh -c "cp /tmp/x ${e}"`, 'bash -lc "touch esc"': e => `bash -lc "touch ${e}"`, 'sh -c "mv"': e => `sh -c "mv /tmp/x ${e}"`, 'bash -c "sed -i"': e => `bash -c "sed -i '' s/a/b/ ${e}"`, 'bash -c "rm"': e => `bash -c "rm -f ${e}"`, 'bash -c "ln"': e => `bash -c "ln -sf /tmp/x ${e}"`,
  "sh -c 'touch esc'": e => `sh -c 'touch ${e}'`, 'sh -c "touch dq-in-dq"': e => `sh -c "touch \\"${e.replaceAll('\\ ', ' ')}\\""`, 'sh -c "touch sq-in-dq"': e => `sh -c "touch '${e.replaceAll('\\ ', ' ')}'"`, 'sh -c "touch dbl-esc"': e => `sh -c "touch ${e.replaceAll('\\ ', '\\\\ ')}"`, 'sh -c $\'touch\'': e => `sh -c $'touch ${e}'`, 'eval "touch"': e => `eval "touch ${e}"`, 'eval touch': e => `eval touch ${e}`, 'sudo sh -c': e => `sudo sh -c "touch ${e}"`, 'sh -c "x; touch"': e => `sh -c "true; touch ${e}"`, 'sh -c "cd; touch"': e => `sh -c "cd ${e.replace(/\/[^/]*$/, '')} && touch ${e.split('/').at(-1)}"`, 'sh -c "a=1 touch"': e => `sh -c "A=1 touch ${e}"`, 'bash -c "$(...)": no': e => `bash -c "touch ${e}" x`, 'bash -c "touch" exec': e => `bash -c "exec touch ${e}"`, 'bash -c nested dq': e => `bash -c "bash -c \\"touch ${e.replaceAll('\\ ', '\\\\ ')}\\""`,
};

export const writerCases = protectedTargets.flatMap(p => Object.entries(reviewerForms).flatMap(([,form]) => Object.values(spellings).map(spell => form(spell(p)))));
export const nestedCases = protectedTargets.flatMap(p => Object.values(shellForms).flatMap(form => [p, p.replace(/^~/, (macHome)), p.replace(/^~/, "$HOME")].map(t => form(t.replaceAll(" ", "\\ ")))));

const dir = '~/Library/Application\\ Support/sleight';
export const directoryReview = [
  // brief examples
  [`cd; echo x > Library/Application\\ Support/sleight/hand.json`, 'bare cd, relative path from HOME'],
  [`cd /tmp; cd; echo x > Library/Application\\ Support/sleight/hand.json`, 'bare cd after /tmp'],
  [`cd ${dir}; (cd /tmp); echo x > hand.json`, 'brief: subshell cd'],
  [`cd ${dir}; cd /tmp; cd -; echo x > hand.json`, 'brief: cd -'],
  [`pushd ${dir}; pushd -n /tmp; echo x > hand.json`, 'brief: pushd -n'],
  [`pushd ${dir}; pushd /tmp; pushd; echo x > hand.json`, 'brief: bare pushd'],
  // synonyms of cd -
  [`cd ${dir}; cd /tmp; cd "$OLDPWD"; echo x > hand.json`, 'cd "$OLDPWD"'],
  [`cd ${dir}; cd /tmp; cd $OLDPWD; echo x > hand.json`, 'cd $OLDPWD'],
  [`cd ${dir}; cd /tmp; cd ~-; echo x > hand.json`, 'cd ~-'],
  [`cd ${dir}; cd /tmp; cd \${OLDPWD}; echo x > hand.json`, 'cd ${OLDPWD}'],
  // conditional cd
  [`cd ${dir} || cd /tmp; echo x > hand.json`, 'cd D || cd /tmp'],
  [`cd ${dir}; true || cd /tmp; echo x > hand.json`, 'true || cd /tmp'],
  [`cd ${dir}; false && cd /tmp; echo x > hand.json`, 'false && cd /tmp'],
  [`cd ${dir}; [ -d /nope ] && cd /tmp; echo x > hand.json`, '[ -d ] && cd /tmp'],
  [`cd ${dir}; cd /nope 2>/dev/null; echo x > hand.json`, 'failing cd (cwd stays D)'],
  [`cd ${dir}; cd /tmp/does-not-exist; echo x > hand.json`, 'failing cd 2'],
  [`cd /tmp; cd ${dir} || true; echo x > hand.json`, 'cd D || true'],
  [`cd ${dir} && cd /tmp || cd ${dir}; echo x > hand.json`, 'cd D && cd /tmp || cd D'],
  [`cd ${dir}; cd /tmp & echo x > hand.json`, 'background cd /tmp'],
  [`cd ${dir}; cd /tmp | cat; echo x > hand.json`, 'cd /tmp | cat (pipe subshell)'],
  [`cd ${dir}; (cd /tmp) ; echo x > hand.json`, 'subshell'],
  [`cd /tmp; { cd ${dir}; }; echo x > hand.json`, 'brace group cd D'],
  [`cd /tmp; if true; then cd ${dir}; fi; echo x > hand.json`, 'then cd D'],
  [`cd /tmp; for i in 1; do cd ${dir}; done; echo x > hand.json`, 'do cd D'],
  [`cd /tmp; ! cd ${dir}; echo x > hand.json`, '! cd D'],
  [`cd /tmp; f() { cd ${dir}; }; f; echo x > hand.json`, 'function cd D'],
  [`cd /tmp; cd ${dir} & wait; echo x > hand.json`, 'cd D &'],
  [`cd /tmp; (cd ${dir}) ; echo x > hand.json`, 'control: subshell cd D then write in /tmp (allow ok)'],
  [`export CDPATH=~/Library/Application\\ Support; cd sleight; echo x > hand.json`, 'CDPATH'],
  [`CDPATH=~/Library/Application\\ Support cd sleight; echo x > hand.json`, 'CDPATH one-shot'],
  [`cd /tmp; cd ${dir}/../../..; cd Application\\ Support/sleight; echo x > hand.json`, 'cd rel chain'],
  [`cd ${dir}; cd ..; cd sleight; echo x > hand.json`, 'cd .. then back'],
  [`cd ~/Library; cd Application\\ Support; cd sleight; echo x > hand.json`, 'cd step by step'],
  [`cd ~/Library/Application\\ Support; echo x > sleight/hand.json`, 'cd parent; write child'],
  [`cd ~/Library; echo x > Application\\ Support/sleight/hand.json`, 'cd Library; write grandchild'],
  [`cd ~/Library/Application\\ Support/sleight/..; echo x > sleight/hand.json`, 'cd D/.., write'],
  [`cd /; echo x > Users/u/Library/Application\\ Support/sleight/hand.json`, 'cd /; write'],
  [`cd ${macHome}; echo x > Library/Application\\ Support/sleight/hand.json`, 'cd ' + macHome],
  [`cd $HOME; echo x > Library/Application\\ Support/sleight/hand.json`, 'cd $HOME'],
  [`cd "$HOME"; echo x > Library/Application\\ Support/sleight/hand.json`, 'cd "$HOME"'],
  [`cd ~; echo x > Library/Application\\ Support/sleight/hand.json`, 'cd ~'],
  [`cd ~u; echo x > Library/Application\\ Support/sleight/hand.json`, 'cd ~u'],
  [`cd ..; echo x > ../Library/Application\\ Support/sleight/hand.json`, 'cd ..'],
  [`pushd ~ >/dev/null; echo x > Library/Application\\ Support/sleight/hand.json`, 'pushd ~'],
  [`pushd; echo x > hand.json`, 'bare pushd no D'],
  // controls (must allow)
  [`cd /tmp; (cd /var); echo x > out.txt`, 'control: subshell, ordinary'],
  [`cd /tmp; cd /var; echo x > out.txt`, 'control: ordinary'],
  [`mkdir -p /tmp/w && cd /tmp/w && echo x > out.txt`, 'control: mkdir cd write'],
  [`pushd /tmp >/dev/null; echo x > out.txt; popd >/dev/null`, 'control: pushd popd'],
  [`cd /tmp && git status && echo done > /tmp/out.txt`, 'control: git'],
  [`cd /tmp; cd -; echo x > /tmp/abs.txt`, 'control: cd - then absolute write'],
  [`cd /tmp; cd -; echo x > rel.txt`, 'control: cd - then relative write (FP expected)'],
  [`cd; echo x > rel.txt`, 'control: bare cd then relative write'],
];

export const dynamicDirectoryCases = [`cd "$(echo ${dir})" && echo x > hand.json`, `cd $(echo ${dir}); touch hand.json`, `d=${dir}; cd $d; touch hand.json`, `cd "\${HOME}/Library/Application Support/sleight"; touch hand.json`, `cd "$HOME/Library/Application Support/sleight"; touch hand.json`, `cd \`echo ${dir}\`; touch hand.json`, `x=sleight; cd ~/Library/Application\\ Support/$x; touch hand.json`, `cd ~/Library/Application\\ Support/s*; touch hand.json`, `cd ~/Library/Application\\ Support/s?eight; touch hand.json`, `cd ~/Library/Application\\ Support/{sleight,x}; touch hand.json`, `cd ~/Lib*/App*/sl*; touch hand.json`];

const S = '~/Library/Application\\ Support/sleight', Sq = '"$HOME/Library/Application Support/sleight"';
export const readWrappers = ['', 'nice', 'nice -n 10', 'timeout 10', 'env', 'env A=1', 'time', 'nohup', 'command', 'sudo -n', 'caffeinate -i', 'stdbuf -oL', 'exec', 'arch -arm64', 'xargs', 'builtin'];
export const reviewerReads = [
  'sleight-mcp --doctor', 'sleight-mcp hand status', 'sleight-mcp turbo status', 'sleight-mcp permissions list', 'sleight --doctor', 'sleight status', 'sleight-mcp status',
  '~/.local/bin/sleight-mcp --doctor', '~/.local/bin/sleight hand status', 'node ~/.claude/plugins/cache/local/sleight/1/bin/launch.mjs --doctor', 'node ~/.claude/plugins/cache/local/sleight/1/bin/launch.mjs hand status',
  'which sleight', 'which sleight-mcp', 'command -v sleight', 'type sleight', 'ls -la ~/.local/bin/sleight', 'file ~/.local/bin/sleight', 'readlink ~/.local/bin/sleight', 'stat ~/.local/bin/sleight',
  `cat ${S}/hand.json`, `cat ${S}/permissions.json | jq .`, `jq . ${S}/preapproved.json`, `jq '.apps' ${S}/turbo-apps.json`, `ls -la ${S}`, `ls ${S}/`, `ls -la ${Sq}`, `find ${S} -name "*.json"`, `find ${S} -type f -maxdepth 1`, `grep -r hand ${S}`, `grep -n turbo ${S}/turbo.json`, `head -c 100 ${S}/hand.json`, `tail -n 5 ${S}/hand.json`, `wc -l ${S}/hand.json`, `stat ${S}/hand.json`, `diff ${S}/hand.json /tmp/x`, `cp ${S}/hand.json /tmp/x`, `cp ${S}/hand.json /tmp/`, `cat ${S}/hand.json > /tmp/out.json`, `jq . ${S}/hand.json > /tmp/out.json`, `tar -czf /tmp/b.tgz -C ~/Library Application\\ Support/sleight`, `md5 ${S}/hand.json`, `shasum -a 256 ${S}/permissions.json`, `plutil -p ~/Library/Preferences/x.plist`, `ls -ld ~/Library/Application\\ Support`, `du -sh ~/Library/Application\\ Support`,
  'grep -rn "sleight-mcp hand" docs/', 'grep "hand status" README.md', 'echo "run sleight-mcp hand status to check"', 'echo "turbo on is the toggle"', 'git commit -m "docs: say sleight hand off in the readme"', 'git log --grep="sleight hand"', 'grep -n "permissions list" docs/*.md', 'grep -rn "doctor" plugins/', 'rg "sleight hand" -g "*.md"', 'echo "sleight turbo on" >> /tmp/notes.txt', 'printf "%s\\n" "sleight hand off" > /tmp/n.txt', 'cat docs/known-problems.md | grep -n "hand off"', 'sed -n "1,20p" docs/status/ROADMAP.md', 'grep -n "launch.mjs" package.json', 'npm run check', 'npm run lint:prose', 'node --test tests/gd5-guard.test.mjs', 'node scripts/x.mjs hand status', 'echo hand', 'echo turbo', 'echo permissions list', 'man sleight', 'sleight --help', 'sleight-mcp --version',
  'echo "$(date) hand status ok" >> /tmp/run.log', 'echo "$(date +%s) turbo ran" >> /tmp/sleight.log', 'echo "[$(date)] starting" | tee -a /tmp/log.txt', 'date >> /tmp/log.txt', 'echo $(date) > /tmp/stamp', 'printf "%s %s\\n" "$(date)" "hand" >> /tmp/x.log', `echo "$(date) saved" >> ~/notes.txt`, 'echo "$(date)" > ~/Library/Logs/mine.log',
  `ls ~/Library/Caches`, 'ls ~/Library/Caches/com.apple.x', `ls ~/.claude/plugins/cache`, `ls ~/.claude/plugins/cache/local/sleight/1/`, 'cat ~/.claude/settings.json', 'jq . ~/.claude/settings.json', 'ls ~/.local/bin', 'ls -la ~', 'cd ~ && ls', 'cd ~/Library && ls', 'cd ~/Library/Application\\ Support && ls', 'cd ~/Library/Application\\ Support/sleight && cat hand.json', 'cd ~/Library/Application\\ Support/sleight && ls -la', 'cd ~/.claude && ls', 'cd /tmp && touch f', 'cd /tmp && echo x > a.txt', 'cd /tmp; (cd /var; ls); echo x > a.txt', 'pushd /tmp > /dev/null; ls; popd > /dev/null', 'cd ~/Library/Application\\ Support/sleight; cat hand.json; cd - ; ls', 'cd "$HOME/Library/Application Support/sleight" && jq . hand.json',
  'curl -s https://example.com/x', 'curl -sSLo /tmp/x.zip https://example.com/x.zip', 'curl -O https://example.com/x.tgz', 'curl -fsSL -o /tmp/f https://example.com/f', 'wget -qO /tmp/x https://example.com/x', 'tar -xzf /tmp/a.tgz -C /tmp/out', 'bsdtar -xf /tmp/a.zip -C /tmp/out', 'unzip -o /tmp/a.zip -d /tmp/out', 'rsync -avt src/ /tmp/dst/', 'rsync -rlptgoD src/ dst/', 'rsync -a --delete src/ dst/', 'sed -i "" s/a/b/ /tmp/f.txt', "sed $'-i' '' s/a/b/ /tmp/f.txt", 'gsed -i s/a/b/ /tmp/f.txt', 'sed -I.bak s/a/b/ ./f.txt', 'arch -arm64 brew install jq', 'arch -x86_64 /bin/ls', 'tee /tmp/o.txt < /dev/null', 'cp a.txt b.txt', 'mv a.txt b.txt', 'rm -rf build', 'rm -rf node_modules', 'rm -rf /tmp/x', 'find . -name "*.o" -delete', 'chmod +x scripts/run.sh', 'ln -sf /tmp/a /tmp/b', 'mkdir -p out/x', 'touch out/x/f', 'git checkout -- .', 'git clean -fd', 'git stash', 'npm install', 'brew install jq', 'python3 -c "print(1)"', "python3 -c \"open('/tmp/x','w').write('a')\"", 'node -e "require(\'fs\').writeFileSync(\'/tmp/x\',\'a\')"', 'sh -c "echo hi"', 'bash -c "cd /tmp && touch f"', 'sh -c "touch /tmp/a\\ b"', 'zsh -c "ls ~/Library"', 'bash -lc "ls"', 'ssh host ls', 'docker ps', 'swift build', 'xcodebuild -scheme X', 'open -a Safari', 'osascript -e "tell app \\"Finder\\" to activate"',
  'make -j8', 'cargo build', 'go test ./...', 'pytest -q', 'ls | head', 'cat f | grep x | wc -l', 'find . -name x | xargs rm', 'ls /tmp > /tmp/ls.txt', 'echo done', 'true', 'pwd', 'whoami', 'uname -a', 'env | sort', 'ps aux | grep sleight', 'pgrep -fl sleight', 'tail -f /tmp/sleight.log', 'cat /tmp/sleight-hold',
];

const matrixD = '~/Library/Application\\ Support/sleight', Dq = '"~/Library/Application Support/sleight"', H = (macHome + '/Library/Application\\ Support/sleight');
const matrixWriters = ['echo x > hand.json', 'touch hand.json', 'tee hand.json <<< x', 'cp /tmp/x hand.json', 'mv /tmp/x permissions.json', 'sed -i "" s/a/b/ hand.json', 'rm -f hand.json', 'ln -sf /tmp/x hand.json'];
// each prefix leaves the shell in D (a protected folder) when modeled correctly -> writer must refuse; or unknown -> relative refuses
const matrixPrefixes = [
  [`cd ${matrixD}`, 'cd D'], [`cd ${Dq}`, 'cd "D"'], [`cd ${H}`, 'cd abs'], [`pushd ${matrixD} >/dev/null`, 'pushd D'], [`builtin cd ${matrixD}`, 'builtin cd'], [`cd -P ${matrixD}`, 'cd -P'], [`cd -L ${matrixD}`, 'cd -L'], [`cd -- ${matrixD}`, 'cd --'], [`cd -e ${matrixD}`, 'cd -e'], [`cd -@ ${matrixD}`, 'cd -@'],
  [`cd ~/Library && cd Application\\ Support && cd sleight`, 'cd chain'], [`cd ~/Library/Application\\ Support/x/..; cd sleight`, 'cd ..'], [`cd ${matrixD}/.`, 'cd .'], [`cd ${matrixD}/../sleight`, 'cd ../'],
  [`cd /tmp; cd ${matrixD}; (cd /tmp)`, 'subshell cd /tmp after cd D'], [`cd ${matrixD}; (cd /tmp; cd /var)`, 'subshell 2 cds'], [`cd ${matrixD}; (pushd /tmp)`, 'subshell pushd'], [`cd ${matrixD}; (cd /tmp; popd)`, 'subshell popd'], [`cd ${matrixD}; ( cd /tmp ) `, 'subshell spaced'], [`cd ${matrixD}; (cd /tmp) && echo ok`, 'subshell &&'], [`cd ${matrixD}; (true; (cd /tmp))`, 'nested subshell'], [`cd ${matrixD}; (cd /tmp) | cat`, 'subshell | cat'], [`cd ${matrixD}; $(cd /tmp)`, '$(cd /tmp)'], [`cd ${matrixD}; echo $(cd /tmp)`, 'echo $(cd)'], ["cd " + matrixD + "; echo `cd /tmp`", 'backtick cd'], [`cd ${matrixD}; { cd /tmp; } `, 'brace group cd'],
  [`cd ${matrixD}; cd /tmp; cd -`, 'cd /tmp; cd -'], [`cd ${matrixD}; cd /tmp; cd - >/dev/null`, 'cd - >/dev/null'], [`cd /tmp; cd ${matrixD}; cd /var; cd -`, 'cd - restore D'], [`cd ${matrixD}; cd $OLDPWD`, 'cd $OLDPWD'], [`cd ${matrixD}; cd /tmp; cd "$OLDPWD"`, 'cd "$OLDPWD"'], [`cd ${matrixD}; cd /tmp; cd ~-`, 'cd ~-'], [`cd ${matrixD}; cd /tmp; cd ~+`, 'cd ~+'], [`cd ${matrixD}; cd /tmp; cd $PWD`, 'cd $PWD'],
  [`pushd ${matrixD}; pushd -n /tmp`, 'pushd -n'], [`pushd ${matrixD}; pushd /tmp; pushd`, 'bare pushd swap'], [`pushd /tmp; pushd ${matrixD}; pushd +1`, 'pushd +1'], [`pushd /tmp; pushd ${matrixD}; pushd +1; pushd +1`, 'pushd +1 x2'], [`pushd ${matrixD}; pushd /tmp; pushd -0`, 'pushd -0'], [`pushd ${matrixD}; pushd /tmp; popd`, 'pushd; popd'], [`pushd ${matrixD}; pushd /tmp; popd +0`, 'popd +0'], [`pushd ${matrixD}; pushd /tmp; popd -n`, 'popd -n'], [`pushd /tmp; pushd ${matrixD}; popd -n; true`, 'popd -n 2'], [`pushd ${matrixD}; popd; pushd ${matrixD}`, 'popd; pushd D'], [`pushd ${matrixD}; pushd /tmp; pushd /var; popd; popd`, 'pushd x3 popd x2'], [`pushd ${matrixD}; pushd /tmp; popd; popd`, 'popd over-pop'], [`pushd ${matrixD}; popd; popd`, 'double popd'],
  [`cd /tmp; cd`, 'bare cd (HOME) then Library path'], [`cd ${matrixD}; cd; cd Library/Application\\ Support/sleight`, 'cd; cd rel'],
  [`cd ${matrixD}; cd /tmp || true`, 'cd /tmp || true'], [`cd /tmp && cd ${matrixD}`, '&&'], [`cd ${matrixD} || cd /tmp`, '|| cd'], [`cd /nonexistent || cd ${matrixD}`, '|| cd D'], [`(cd /tmp; cd ${matrixD}; echo ok)`, 'sub-contained'],
  [`cd ${matrixD}\ncd /tmp\ncd -`, 'newline cd -'], [`export CDPATH=~/Library/Application\\ Support; cd sleight`, 'CDPATH'], [`cd ${matrixD}; unset PWD; cd /tmp; cd -`, 'unset'], [`cd ${matrixD}; cd "$(echo /tmp)"; cd -`, 'cd $(echo)'], [`d=${matrixD}; cd $d`, 'cd $var'], [`cd ${matrixD}; cd /tmp; popd`, 'popd w/o stack'], [`cd ${matrixD}; cd /tmp; dirs -c; cd -`, 'dirs -c'], [`cd ${matrixD}; chdir /tmp; cd -`, 'chdir'],
];

export const directoryMatrix = matrixPrefixes.flatMap(([prefix, name]) => matrixWriters.map(write => ({ name, command: `${prefix}; ${write}` })));
