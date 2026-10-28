# Run me: type  exec(open("hello.py").read())  at the >>> prompt,
# or set the Command field to  python hello.py  and click Run again.
name = input("Your name? ")
print(f"Hello, {name}!")
with open("greetings.txt", "a") as f:
    f.write(f"Hello, {name}!\n")
print("Wrote greetings.txt. Click Save to keep it in this file.")
