// Ordinary developer commands the write guard must allow, run from a repository with a src folder and package.json
// (hot161b review, 2026-11-12: 64 commands, every one allowed with the host-shaped stat on a real disk). Data only.
const TMP = ['', 'private', 'tmp'].join('/');
export const ordinaryDeveloperCommands = [
  'npm test 2>&1 | tail -20', 'npm run build > build.log 2>&1', 'npm run build &> build.log', 'npm run dev > dev.log 2>&1 &', 'node server.js >/dev/null 2>&1 &', 'make -j8 2>&1 | tee build/make.log',
  'mkdir -p build/out && cp -R src/. build/out/', 'mkdir -p dist/a/b/c', 'touch src/new.ts', 'cp package.json package.bak', 'cp -r src src2', 'mv src/new.ts src/renamed.ts',
  'git worktree add ../wt-feature -b feature/x', `git worktree add ${TMP}/wt-new`, 'git clone https://example.invalid/r.git newrepo', 'git diff > patch.diff', 'git log --oneline | head -5 > log.txt',
  'echo "hello" > notes.md', 'echo "line" >> notes.md', 'cat <<EOF > config.yml\na: 1\nEOF', "cat <<'EOF' > script.sh\necho hi\nEOF", 'printf "%s\\n" a b > list.txt',
  'ls -la 2>/dev/null', 'cmd 2>&1 >/dev/null', 'find . -name "*.log" 2>/dev/null | head', 'grep -r TODO src > todos.txt', 'cd src && touch a.ts && cd ..', 'cd build 2>/dev/null || mkdir build',
  'curl -sS https://example.invalid/data.json -o data.json', 'curl -sS https://example.invalid/data.json > data.json', 'tar czf backup.tgz src', 'python3 script.py > out.txt 2>&1', 'pytest -q 2>&1 | tail -5',
  'sort < in.txt > out.txt', 'diff a b > d.patch; true', 'tee out.log < /dev/null', 'echo done | tee -a run.log', 'time make 2>&1 | tee time.log', '(cd src && make) > make.out 2>&1',
  'cargo build 2> err.log', 'ssh host "ls" > hosts.txt 2>&1', 'docker build . 2>&1 | tee docker.log', 'exec 3>&1', 'echo x >&2', 'echo err 1>&2', 'sleep 1 & wait', 'cmd >| out.txt', 'cmd >! out.txt', 'cmd &>>run.log',
  'echo "a > b" ', 'echo "x" | cat > /dev/null', 'if [ -f a ]; then echo yes > yes.txt; fi', 'for f in *.txt; do cat $f >> all.txt; done', 'echo $(date) > date.txt', 'cat a b | sort -u > c',
  'ls 2>&1 | grep -v x', 'exec 2>&1', 'cmd < in.txt', 'cat <> /dev/null', 'rm -rf build dist', 'rm -f out.txt', 'ln -s src srclink', 'chmod +x script.sh', 'sed -i.bak s/a/b/ notes.md',
];
// Named in the same review as allowed, outside the 64.
export const ordinaryExtras = ['echo x >&$FD', '[[ a > b ]]', 'echo $((a>>b)) > out.txt'];
// Long multi-line commands are ordinary; a backslash-newline or a pipe-continued line is not a reason to refuse.
export const ordinaryMultiline = [
  'npm run build \\\n  --workspace app \\\n  > build.log 2>&1',
  'docker run --rm \\\n  -v "$PWD:/w" \\\n  -w /w node:20 \\\n  npm test | tee ci.log',
  'grep -rn TODO src |\n  sort |\n  uniq -c > todos.txt',
  'for f in a b c; do \\\n  echo "$f" >> list.txt; \\\ndone',
  'git log \\\n  --oneline \\\n  --since="1 week ago" \\\n  > recent.txt # weekly',
];
