.PHONY: verify wrong-volume
verify:
	@node cli.ts

wrong-volume:
	@node cli.ts --wrong-volume
