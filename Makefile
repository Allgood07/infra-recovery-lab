.PHONY: verify wrong-volume
verify:
	@python3 verify.py

wrong-volume:
	@python3 verify.py --wrong-volume
