book:
    npm start -- --force

gh-book:
    gh workflow run book.yml -f force=true
    sleep 5
    gh run watch $(gh run list --workflow=book.yml --limit 1 --json databaseId -q '.[0].databaseId')

gh-logs:
    gh run view $(gh run list --workflow=book.yml --limit 1 --json databaseId -q '.[0].databaseId') --log
